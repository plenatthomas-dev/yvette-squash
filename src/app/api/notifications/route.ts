import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { NOTIFICATION_PAGE } from "@/lib/notify-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/notifications : mes dernières notifications, et combien sont non lues.
//
// Pas de flag de fonction : ce journal n'appartient à aucune fonctionnalité en particulier —
// il reçoit aussi bien les alertes « terrain libéré » que les annonces du club ou le suivi
// interclub. Le couper reviendrait à cacher des notifications déjà envoyées.
//
// Une SEULE requête sert la liste ET la pastille : compter séparément doublerait le coût d'un
// appel fait à chaque chargement de page.
export async function GET(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const rows = await prisma.appNotification.findMany({
    where: { userId: session.userId },
    orderBy: { createdAt: "desc" },
    take: NOTIFICATION_PAGE,
    select: { id: true, title: true, body: true, url: true, createdAt: true, readAt: true },
  });

  return NextResponse.json({
    items: rows.map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body,
      url: n.url,
      at: n.createdAt.toISOString(),
      read: n.readAt !== null,
    })),
    unread: rows.filter((n) => n.readAt === null).length,
  });
}

// POST /api/notifications : marque tout comme lu.
//
// Tout, et pas ligne par ligne : la cloche se consulte d'un coup d'œil, et demander à
// l'utilisateur d'acquitter chaque ligne serait une corvée pour une information déjà lue.
export async function POST(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { count } = await prisma.appNotification.updateMany({
    where: { userId: session.userId, readAt: null },
    data: { readAt: new Date() },
  });
  return NextResponse.json({ ok: true, read: count });
}

// DELETE /api/notifications[?scope=read] : vider la cloche.
//
// Deux portées, parce qu'elles répondent à deux gestes différents : `read` fait le ménage de
// ce qu'on a déjà vu — l'usage courant, sans risque de perdre quelque chose —, tandis que la
// portée par défaut efface tout, y compris le non lu, pour repartir de zéro.
export async function DELETE(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const onlyRead = req.nextUrl.searchParams.get("scope") === "read";
  const { count } = await prisma.appNotification.deleteMany({
    where: onlyRead
      ? { userId: session.userId, readAt: { not: null } }
      : { userId: session.userId },
  });
  return NextResponse.json({ ok: true, removed: count });
}
