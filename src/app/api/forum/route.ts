import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { isAdminEmail } from "@/lib/admin";
import { getFeatures } from "@/lib/features-server";
import { readJsonBody } from "@/lib/http-tx";
import { parseForumBody, forumPreview, MAX_FORUM_LEN } from "@/lib/forum";
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

/** Ce que l'écran reçoit pour un message. `authorName` est le nom d'affichage, jamais le surnom. */
type Row = {
  id: string;
  body: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  canDelete: boolean;
};

type Raw = {
  id: string;
  body: string;
  authorId: string;
  createdAt: Date;
  author: { displayName: string } | null;
};

const shape = (m: Raw, viewerId: string, admin: boolean): Row => ({
  id: m.id,
  body: m.body,
  authorId: m.authorId,
  // L'auteur peut avoir disparu entre la lecture et l'affichage (compte supprimé, Cascade) —
  // la jointure est alors nulle et le message est en train d'être effacé.
  authorName: m.author?.displayName ?? "Membre supprimé",
  createdAt: m.createdAt.toISOString(),
  canDelete: admin || m.authorId === viewerId,
});

const SELECT = {
  id: true,
  body: true,
  authorId: true,
  createdAt: true,
  author: { select: { displayName: true } },
} as const;

/**
 * GET /api/forum?limit=30[&since=<id>]
 *
 * Sans `since` : la page la plus RÉCENTE, plus `hasMore` pour le bouton « messages plus
 * anciens ». Même forme que partout ailleurs dans l'appli (`take: limit + 1`), pas de curseur.
 *
 * Avec `since` : le RATTRAPAGE après une coupure de la WebSocket — tout ce qui a été écrit
 * depuis ce message. C'est ce qui rend le courtier remplaçable : rater des événements ne coûte
 * qu'une requête au retour.
 */
export async function GET(req: NextRequest) {
  if (!(await getFeatures()).forum) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const admin = isAdminEmail(session.email);
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
        select: SELECT,
      });
      return NextResponse.json({
        messages: rows.map((m) => shape(m, session.userId, admin)),
        hasMore: false,
      });
    }
  }

  const rows = await prisma.forumMessage.findMany({
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    select: SELECT,
  });
  // L'état du réglage voyage avec la page : c'est une colonne de la ligne du membre, que la
  // session a déjà chargée côté base. Une route dédiée coûterait un aller-retour de plus pour
  // un booléen.
  const moi = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { forumMuted: true },
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return NextResponse.json({
    muted: moi?.forumMuted ?? false,
    // Rendu du plus ANCIEN au plus récent : c'est l'ordre d'affichage d'une messagerie, et
    // l'inverser ici évite de le refaire dans le composant à chaque rendu.
    messages: page.reverse().map((m) => shape(m, session.userId, admin)),
    hasMore,
  });
}

/** POST /api/forum { body } -> 201 { message }. Tout membre connecté écrit dans le fil. */
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

  const created = await prisma.forumMessage.create({
    data: { authorId: session.userId, body: text },
    select: SELECT,
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
  // autres un message qui pourrait n'être jamais enregistré. `canDelete` est calculé chez
  // chaque destinataire, jamais diffusé — il dépend de qui regarde.
  const shaped = shape(created, session.userId, false);
  await broadcastForum(FORUM_EVENT_MESSAGE, {
    id: shaped.id,
    body: shaped.body,
    authorId: shaped.authorId,
    authorName: shaped.authorName,
    createdAt: shaped.createdAt,
  });

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
