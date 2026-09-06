import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getFeatures } from "@/lib/features-server";
import { readJsonBody } from "@/lib/http-tx";
import {
  parseForumBody,
  parseForumOption,
  forumPreview,
  MAX_FORUM_LEN,
  MIN_POLL_OPTIONS,
  MAX_POLL_OPTIONS,
  JOURNAL_FORUM,
} from "@/lib/forum";
import { SELECT_MESSAGE, shapeMessage, shapePoll, INCLUDE_POLL } from "@/lib/forum-db";
import { FORUM_RETENTION_MS } from "@/lib/retention";
import { pushToUsers } from "@/lib/push";
import { broadcastForum, FORUM_EVENT_MESSAGE, FORUM_EVENT_POLL } from "@/lib/forum-realtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 30;

/**
 * POST /api/forum/poll { question, options: string[] } -> 201 { message, poll }
 *
 * LE SONDAGE EST UN MESSAGE. La question devient le `body` du message porteur, et le sondage
 * s'y accroche par une relation 1-1. Ce choix évite d'écrire un cycle de vie entier : la
 * suppression, la purge à 12 mois, la notification push et la place chronologique dans le fil
 * sont exactement celles d'un message ordinaire, sans une ligne de plus.
 *
 * Conséquence utile : un client qui ignorerait les sondages afficherait quand même la question
 * comme un message lisible.
 */
export async function POST(req: NextRequest) {
  if (!(await getFeatures()).forum) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const raw = await readJsonBody(req);
  const question = parseForumBody(raw?.question);
  if (!question) {
    return NextResponse.json(
      { error: `Question invalide (1 à ${MAX_FORUM_LEN} caractères)` },
      { status: 400 },
    );
  }

  const brutes = Array.isArray(raw?.options) ? raw.options : [];
  // On nettoie AVANT de compter : trois champs dont un laissé vide font deux options, pas
  // trois, et l'écran doit refuser à ce moment-là — pas créer un sondage bancal.
  const labels: string[] = [];
  const vues = new Set<string>();
  for (const o of brutes) {
    const l = parseForumOption(o);
    if (!l) continue;
    // Deux options identiques rendraient le résultat indécidable : « Jeudi » et « Jeudi »
    // séparent les voix de ceux qui voulaient dire la même chose. La comparaison IGNORE LA
    // CASSE et les accents — « Jeudi » et « jeudi » produisaient sinon exactement
    // l'indécidabilité que ce contrôle existe pour empêcher, et personne ne relit deux
    // options qu'on vient de taper soi-même. C'est le PREMIER écrit qui est gardé, avec sa
    // casse : c'est celui que l'auteur a voulu.
    const cle = l
      .toLocaleLowerCase("fr-FR")
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "");
    if (vues.has(cle)) continue;
    vues.add(cle);
    labels.push(l);
  }
  if (labels.length < MIN_POLL_OPTIONS || labels.length > MAX_POLL_OPTIONS) {
    return NextResponse.json(
      { error: `Il faut entre ${MIN_POLL_OPTIONS} et ${MAX_POLL_OPTIONS} réponses distinctes.` },
      { status: 400 },
    );
  }

  const recent = await prisma.forumMessage.count({
    where: { authorId: session.userId, createdAt: { gte: new Date(Date.now() - WINDOW_MS) } },
  });
  if (recent >= MAX_PER_WINDOW) {
    return NextResponse.json(
      { error: "Trop de messages d'un coup. Reprends dans quelques minutes." },
      { status: 429 },
    );
  }

  // Message, sondage et options dans UNE transaction : un sondage sans options, ou un message
  // qui promet un vote impossible, serait pire que pas de sondage du tout.
  const { message, poll } = await prisma.$transaction(async (tx) => {
    const message = await tx.forumMessage.create({
      data: { authorId: session.userId, body: question },
      select: SELECT_MESSAGE,
    });
    const poll = await tx.forumPoll.create({
      data: {
        messageId: message.id,
        options: { create: labels.map((label, position) => ({ label, position })) },
      },
      // `INCLUDE_POLL` et non une copie : c'est le même objet que celui de la lecture, donc
      // le sondage diffusé à la création a exactement la forme de celui que le GET renvoie.
      // Une seconde définition, ici, finirait par en diverger sur un détail — l'ordre des
      // options, ou la présence du nom d'un votant.
      include: INCLUDE_POLL,
    });
    return { message, poll };
  });

  // La purge des 12 mois est greffée ICI AUSSI. Elle ne l'était que sur `POST /api/forum`, et
  // c'était sans conséquence — le premier message ordinaire rattrapait —, mais une asymétrie
  // non écrite entre deux routes qui créent toutes deux un message finit par se lire comme un
  // oubli. Best-effort, comme là-bas : une purge en échec ne fait pas échouer le sondage.
  try {
    await prisma.forumMessage.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - FORUM_RETENTION_MS) } },
    });
  } catch {
    /* la purge repassera au prochain message */
  }

  const shaped = shapeMessage(message);
  const shapedPoll = shapePoll(poll);
  // DEUX ÉVÉNEMENTS, ET NON UN MESSAGE ENRICHI. La doctrine du fil est que « la ligne diffusée
  // est EXACTEMENT celle que le GET renvoie » : y greffer un champ `poll` obligeait le client à
  // connaître une seconde forme de message, et faisait mentir le contrat au moment même où il
  // compte le plus. Le sondage part sur son propre canal, celui qu'écoutent déjà le vote et la
  // clôture — c'est-à-dire le même chemin qu'après un rechargement.
  //
  // Le sondage AVANT le message : un `poll` reçu pour un message qu'on n'a pas encore est rangé
  // sans dommage (il est indexé par `messageId`), tandis qu'un message affiché une fraction de
  // seconde sans son sondage se verrait.
  await broadcastForum(FORUM_EVENT_POLL, shapedPoll);
  await broadcastForum(FORUM_EVENT_MESSAGE, shaped);

  const destinataires = await prisma.user.findMany({
    where: { disabledAt: null, forumMuted: false, id: { not: session.userId } },
    select: { id: true },
  });
  // Le JOURNAL ne porte pas la question, pour la même raison qu'il ne porte pas un message :
  // c'est une copie durable chez chaque destinataire, que rien n'efface ensuite. Voir la note
  // sur `JOURNAL_FORUM`.
  await pushToUsers(
    destinataires.map((u) => u.id),
    {
      title: `📊 ${message.author?.displayName ?? "Un membre"}`,
      body: forumPreview(question),
      url: "/?view=forum",
      tag: "forum",
      renotify: true,
    },
    { journal: JOURNAL_FORUM },
  );

  return NextResponse.json({ message: shaped, poll: shapedPoll }, { status: 201 });
}
