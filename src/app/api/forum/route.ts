import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { isAdminEmail } from "@/lib/admin";
import { getFeatures } from "@/lib/features-server";
import { readJsonBody, isForeignKeyViolation } from "@/lib/http-tx";
import { parseForumBody, forumPreview, MAX_FORUM_LEN, JOURNAL_FORUM } from "@/lib/forum";
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

/**
 * GET /api/forum?limit=30[&since=<id>]
 *
 * Sans `since` : la page la plus RÉCENTE, plus `hasMore` pour le bouton « messages plus
 * anciens ». Même forme que partout ailleurs dans l'appli (`take: limit + 1`), pas de curseur.
 *
 * Avec `since` : le RATTRAPAGE après une coupure de la WebSocket. C'est ce qui rend le courtier
 * remplaçable : rater des événements ne coûte qu'une requête au retour.
 *
 * ⚠️ UN RATTRAPAGE NE PORTE PAS QUE LES MESSAGES NEUFS. Pendant la coupure, un membre a pu
 * réagir à un message DÉJÀ affiché, voter dans un sondage déjà affiché, ou supprimer le sien.
 * Aucun de ces trois gestes ne crée de message, donc aucun ne serait rattrapé si l'on se
 * contentait de la tranche « après l'ancre » — et c'est précisément le chemin emprunté quand le
 * courtier n'est pas là. La réponse porte donc aussi :
 *
 *   * `reactions` / `polls` pour la FENÊTRE VISIBLE (les `limit` plus récents), et pas
 *     seulement pour les messages neufs — le client REMPLACE ce qu'il détient sur ces
 *     identifiants au lieu de le compléter ;
 *   * `fenetre` = les identifiants encore en base dans cette fenêtre, et la date du plus ancien
 *     d'entre eux. Ce que le client détient dans cet intervalle et qui n'y figure pas a été
 *     supprimé ailleurs : c'est le seul canal qui rattrape une suppression manquée.
 *
 * `complet` dit lequel des deux modes la réponse rend RÉELLEMENT, qui n'est pas toujours celui
 * qu'on a demandé : une ancre inconnue ou un retard trop grand font retomber sur une page
 * entière, que le client doit alors substituer et non fusionner.
 *
 * La réponse porte `meId`, `meName` et `admin` UNE fois, jamais un booléen par ligne : voir la
 * note sur `MessageRow` dans lib/forum-db.ts.
 */
export async function GET(req: NextRequest) {
  if (!(await getFeatures()).forum) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const raw = Number(req.nextUrl.searchParams.get("limit"));
  const limit =
    Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_LIMIT) : DEFAULT_LIMIT;
  const since = req.nextUrl.searchParams.get("since");

  // La ligne du membre, lue dans LES DEUX modes. Le rattrapage l'omettait, et le client, qui
  // teste la présence de `meId` pour décider s'il tient une identité, réécrivait alors son
  // propre nom avec le défaut « Moi » — visible dès la réaction suivante, dans l'infobulle des
  // réactants. `forumMuted` en profite : le réglage coupé sur un autre appareil se rattrape.
  const moi = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { forumMuted: true, displayName: true },
  });
  const identite = {
    meId: session.userId,
    admin: isAdminEmail(session.email),
    // Son propre nom, pour que l'affichage OPTIMISTE d'une réaction porte le bon libellé avant
    // même que le courtier ait renvoyé le delta.
    meName: moi?.displayName ?? "Moi",
    muted: moi?.forumMuted ?? false,
  };

  if (since) {
    // L'ancre porte SON IDENTIFIANT autant que sa date. `createdAt` est un `TIMESTAMP(3)` :
    // deux messages écrits dans la même milliseconde — deux clics simultanés un soir de
    // convocation — partagent la même valeur, et un `>` strict sur la seule date en saute un
    // définitivement, sans que personne ne puisse le savoir. L'identifiant départage.
    const ancre = await prisma.forumMessage.findUnique({
      where: { id: since },
      select: { id: true, createdAt: true },
    });
    // Ancre inconnue (message supprimé ou purgé entre-temps) : on retombe sur la page récente
    // plutôt que de ne rien rendre.
    if (ancre) {
      // `MAX_LIMIT + 1` pour SAVOIR qu'on déborde, et non pour rendre une ligne de plus. Un
      // rattrapage tronqué n'est pas un rattrapage : garder les 200 plus ANCIENS d'une absence
      // de 260 messages rendait exactement ceux dont on n'a que faire, et se déclarait complet.
      // Au-delà de la borne on renonce et l'on rend une page entière — la seule réponse qui
      // laisse le client dans un état vrai.
      const nouveaux = await prisma.forumMessage.findMany({
        // « Plus récent que l'ancre, OU de la même milliseconde mais d'identifiant supérieur ».
        // Le tri suit la même paire, sinon la borne et l'ordre ne parleraient pas du même
        // découpage — et l'un des deux messages simultanés reviendrait à chaque rattrapage.
        where: {
          OR: [
            { createdAt: { gt: ancre.createdAt } },
            { createdAt: ancre.createdAt, id: { gt: ancre.id } },
          ],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: MAX_LIMIT + 1,
        select: SELECT_MESSAGE,
      });
      if (nouveaux.length <= MAX_LIMIT) {
        // La fenêtre que le client a sous les yeux, telle qu'elle est ENCORE en base. Deux
        // colonnes seulement : c'est un balayage de l'index `createdAt`, pas une lecture de
        // messages.
        const fenetre = await prisma.forumMessage.findMany({
          orderBy: { createdAt: "desc" },
          take: limit,
          select: { id: true, createdAt: true },
        });
        const ids = [...new Set([...fenetre.map((m) => m.id), ...nouveaux.map((m) => m.id)])];
        const [reactions, polls] = await Promise.all([
          chargerReactions(ids),
          chargerSondages(ids),
        ]);
        return NextResponse.json({
          ...identite,
          complet: false,
          messages: nouveaux.map(shapeMessage),
          reactions,
          polls,
          fenetre: {
            ids: fenetre.map((m) => m.id),
            // Le plus ANCIEN de la fenêtre. En deçà, le client peut détenir des messages que
            // cette réponse ne couvre pas (il a demandé « plus anciens ») : il ne doit rien y
            // élaguer. Fenêtre vide = plus rien en base, donc tout est à élaguer.
            depuis: (fenetre.at(-1)?.createdAt ?? new Date(0)).toISOString(),
          },
          hasMore: false,
        });
      }
    }
  }

  const rows = await prisma.forumMessage.findMany({
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    select: SELECT_MESSAGE,
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const ids = page.map((m) => m.id);
  // Deux APPELS ajoutés, et deux seulement quelle que soit la taille de la page — pas un
  // `include` par message. Ils ne coûtent pas deux ORDRES SQL pour autant : dans la stratégie
  // de chargement par défaut de Prisma, `chargerReactions` en émet deux (les lignes, puis les
  // `User` joints) et `chargerSondages` quatre. Ils tombent sur l'OUVERTURE DU FIL, geste
  // délibéré et rare, jamais sur l'écran d'accueil : c'est ce qui les rend compatibles avec
  // PRODUCT.md.
  const [reactions, polls] = await Promise.all([chargerReactions(ids), chargerSondages(ids)]);
  return NextResponse.json({
    ...identite,
    // Cette réponse se SUBSTITUE à ce que le client détient — y compris s'il avait demandé un
    // rattrapage : deux chemins ci-dessus retombent ici.
    complet: true,
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

  // CITATION. Le client ne fournit qu'un IDENTIFIANT, jamais un texte : sinon n'importe qui
  // pourrait faire dire n'importe quoi à n'importe qui, sous son nom, de façon durable et
  // crédible. Le nom et l'extrait affichés sont relus par jointure à chaque lecture
  // (`SELECT_MESSAGE`), et rien n'en est recopié dans cette ligne.
  //
  // Une cible inconnue — supprimée ou purgée entre l'ouverture du fil et l'envoi — ne fait PAS
  // échouer l'envoi : le message part sans citation. Perdre le contexte d'une réponse est moins
  // grave que perdre la réponse. La course reste possible (la cible peut disparaître ENTRE la
  // vérification et l'écriture) : la clé étrangère rend alors P2003, qu'on rattrape pour
  // rejouer sans citation plutôt que de rendre un 500 en perdant le message.
  const cible =
    typeof raw?.replyTo === "string" && raw.replyTo
      ? await prisma.forumMessage.findUnique({
          where: { id: raw.replyTo },
          select: { id: true },
        })
      : null;

  const ecrire = (replyToId: string | null) =>
    prisma.forumMessage.create({
      data: { authorId: session.userId, body: text, replyToId },
      select: SELECT_MESSAGE,
    });
  let created;
  try {
    created = await ecrire(cible?.id ?? null);
  } catch (e) {
    if (!cible || !isForeignKeyViolation(e)) throw e;
    created = await ecrire(null);
  }

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
  //
  // LE JOURNAL NE PORTE PAS LE MESSAGE (`journal`, cf. lib/push.ts). Le push, lui, l'affiche :
  // il vit dans le centre de notifications du téléphone, que son propriétaire vide. Le journal
  // de la cloche, lui, écrit une ligne `AppNotification` DURABLE (30 jours) chez chacun des
  // trente membres. Y recopier le texte revenait à en faire trente copies que ni la suppression
  // du message, ni la suppression du compte de son auteur n'atteignent — l'admin qui retire une
  // insulte n'en retirait aucune. Le tag rouvre le fil, où l'état courant fait foi.
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
    { journal: JOURNAL_FORUM },
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
