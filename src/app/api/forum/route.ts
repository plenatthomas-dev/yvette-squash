import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { isAdminEmail } from "@/lib/admin";
import { getFeatures } from "@/lib/features-server";
import { readJsonBody } from "@/lib/http-tx";
import { parseForumBody, forumPreview, MAX_FORUM_LEN } from "@/lib/forum";
import {
  SELECT_MESSAGE,
  shapeMessage,
  chargerReactions,
  chargerSondages,
} from "@/lib/forum-db";
import { FORUM_RETENTION_MS } from "@/lib/retention";
import { pushToUsers } from "@/lib/push";
import { broadcastForum, FORUM_EVENT_MESSAGE } from "@/lib/forum-realtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Même garde-fou que le fil des frais partagés, et pour la même raison : le club est sur
// invitation, donc le risque n'est pas l'inconnu malveillant mais le client qui boucle ou le
// compte compromis, qui rempliraient Neon. Volontairement large — une conversation réelle n'en
// approche jamais. Compteur en base : les fonctions serverless ne partagent pas de mémoire.
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 30;

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;

/** Longueur de l'extrait cité, en points de code. Assez pour reconnaître, trop peu pour relire. */
const EXCERPT_LEN = 90;

/**
 * GET /api/forum?limit=30[&since=<id>]
 *
 * Sans `since` : la page la plus RÉCENTE, plus `hasMore` pour le bouton « messages plus
 * anciens ». Même forme que partout ailleurs dans l'appli (`take: limit + 1`), pas de curseur.
 *
 * Avec `since` : le RATTRAPAGE après une coupure de la WebSocket — tout ce qui a été écrit
 * depuis ce message. C'est ce qui rend le courtier remplaçable : rater des événements ne coûte
 * qu'une requête au retour.
 *
 * La réponse porte `meId` et `admin` UNE fois, jamais un booléen par ligne : voir la note sur
 * `MessageRow` dans lib/forum-db.ts.
 */
export async function GET(req: NextRequest) {
  if (!(await getFeatures()).forum) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const identite = { meId: session.userId, admin: isAdminEmail(session.email) };
  const raw = Number(req.nextUrl.searchParams.get("limit"));
  const limit =
    Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_LIMIT) : DEFAULT_LIMIT;
  const since = req.nextUrl.searchParams.get("since");

  if (since) {
    const ancre = await prisma.forumMessage.findUnique({
      where: { id: since },
      select: { createdAt: true },
    });
    // Ancre inconnue (message supprimé ou purgé entre-temps) : on retombe sur la page récente
    // plutôt que de ne rien rendre.
    if (ancre) {
      // On borne le rattrapage : une coupure d'une semaine ne doit pas rapatrier tout le fil.
      const rows = await prisma.forumMessage.findMany({
        where: { createdAt: { gt: ancre.createdAt } },
        orderBy: { createdAt: "asc" },
        take: MAX_LIMIT,
        select: SELECT_MESSAGE,
      });
      const ids = rows.map((m) => m.id);
      const [reactions, polls] = await Promise.all([
        chargerReactions(ids),
        chargerSondages(ids),
      ]);
      return NextResponse.json({
        ...identite,
        messages: rows.map(shapeMessage),
        reactions,
        polls,
        hasMore: false,
      });
    }
  }

  const rows = await prisma.forumMessage.findMany({
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    select: SELECT_MESSAGE,
  });
  // L'état du réglage voyage avec la page : c'est une colonne de la ligne du membre, que la
  // session a déjà chargée côté base. Une route dédiée coûterait un aller-retour de plus pour
  // un booléen.
  const moi = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { forumMuted: true, displayName: true },
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const ids = page.map((m) => m.id);
  // Deux requêtes ajoutées, et deux seulement quelle que soit la taille de la page — pas un
  // `include` par message. Elles tombent sur l'OUVERTURE DU FIL, geste délibéré et rare,
  // jamais sur l'écran d'accueil : c'est ce qui les rend compatibles avec PRODUCT.md.
  const [reactions, polls] = await Promise.all([chargerReactions(ids), chargerSondages(ids)]);
  return NextResponse.json({
    muted: moi?.forumMuted ?? false,
    ...identite,
    // Son propre nom, pour que l'affichage OPTIMISTE d'une réaction porte le bon libellé
    // avant même que le courtier ait renvoyé le delta. Aucune requête de plus : la ligne du
    // membre était déjà lue pour `forumMuted`.
    meName: moi?.displayName ?? "Moi",
    // Rendu du plus ANCIEN au plus récent : c'est l'ordre d'affichage d'une messagerie, et
    // l'inverser ici évite de le refaire dans le composant à chaque rendu.
    messages: page.reverse().map(shapeMessage),
    reactions,
    polls,
    hasMore,
  });
}

/**
 * POST /api/forum { body, replyTo? } -> 201 { message }. Tout membre connecté écrit dans le fil.
 */
export async function POST(req: NextRequest) {
  if (!(await getFeatures()).forum) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const raw = await readJsonBody(req);
  const text = parseForumBody(raw?.body);
  if (!text) {
    return NextResponse.json(
      { error: `Message invalide (1 à ${MAX_FORUM_LEN} caractères)` },
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

  // CITATION. L'extrait est RELU EN BASE, jamais repris de ce que le client envoie : sinon
  // n'importe qui pourrait faire dire n'importe quoi à n'importe qui, sous son nom, de façon
  // durable et crédible. Le client ne fournit qu'un identifiant.
  //
  // Une cible inconnue (supprimée ou purgée entre l'ouverture du fil et l'envoi) ne fait PAS
  // échouer l'envoi : le message part sans citation. Perdre le contexte d'une réponse est
  // moins grave que perdre la réponse.
  let citation: { replyToId: string; replyToAuthor: string; replyToExcerpt: string } | null =
    null;
  if (typeof raw?.replyTo === "string" && raw.replyTo) {
    const cible = await prisma.forumMessage.findUnique({
      where: { id: raw.replyTo },
      select: { id: true, body: true, author: { select: { displayName: true } } },
    });
    if (cible) {
      citation = {
        replyToId: cible.id,
        replyToAuthor: cible.author?.displayName ?? "Membre supprimé",
        replyToExcerpt: forumPreview(cible.body, EXCERPT_LEN),
      };
    }
  }

  const created = await prisma.forumMessage.create({
    data: { authorId: session.userId, body: text, ...(citation ?? {}) },
    select: SELECT_MESSAGE,
  });

  // La purge des 12 mois est greffée ICI plutôt que sur un cron : le plan Vercel les plafonne
  // (cf. le même arbitrage dans lib/moderation.ts), et cette requête arrive de toute façon sur
  // une base déjà réveillée par l'écriture qui précède. Best-effort : une purge en échec ne
  // doit pas faire échouer l'envoi d'un message.
  try {
    await prisma.forumMessage.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - FORUM_RETENTION_MS) } },
    });
  } catch {
    /* la purge repassera au prochain message */
  }

  // Le message part au courtier APRÈS l'écriture : diffuser d'abord ferait exister chez les
  // autres un message qui pourrait n'être jamais enregistré. La ligne diffusée est EXACTEMENT
  // celle que le GET renvoie — aucun champ qui dépendrait du destinataire, donc aucune
  // divergence possible entre un message reçu en direct et le même après rechargement.
  const shaped = shapeMessage(created);
  await broadcastForum(FORUM_EVENT_MESSAGE, shaped);

  // NOTIFICATION — un seul `tag`, donc une seule ligne dans le centre de notifications, qui se
  // remplace au lieu de s'empiler. Sans cela, une soirée animée en produirait trente.
  // `renotify` pour que la suivante soit tout de même entendue (cf. public/sw.js).
  const destinataires = await prisma.user.findMany({
    where: { disabledAt: null, forumMuted: false, id: { not: session.userId } },
    select: { id: true },
  });
  await pushToUsers(
    destinataires.map((u) => u.id),
    {
      title: `💬 ${created.author?.displayName ?? "Un membre"}`,
      body: forumPreview(text),
      url: "/?view=forum",
      tag: "forum",
      renotify: true,
    },
  );

  return NextResponse.json({ message: shaped }, { status: 201 });
}

/**
 * PATCH /api/forum { muted: boolean } — couper ou rétablir les notifications du fil.
 *
 * OPT-OUT et non opt-in, contrairement au suivi d'une équipe interclub : un fil de club que
 * personne ne reçoit ne vit pas. Mais la note de confidentialité promet que le réglage existe
 * et se trouve « depuis le fil lui-même » — cette route est ce qui rend la phrase vraie.
 */
export async function PATCH(req: NextRequest) {
  if (!(await getFeatures()).forum) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const raw = await readJsonBody(req);
  if (typeof raw?.muted !== "boolean") {
    return NextResponse.json({ error: "Réglage invalide" }, { status: 400 });
  }
  await prisma.user.update({
    where: { id: session.userId },
    data: { forumMuted: raw.muted },
  });
  return NextResponse.json({ muted: raw.muted });
}
