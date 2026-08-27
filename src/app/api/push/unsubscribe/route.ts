import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/push/unsubscribe  { endpoint? }
//
// Se désabonner des notifications. Cette route MANQUAIT : on pouvait s'abonner, jamais
// l'inverse — se déconnecter ne suffisait pas, la ligne `PushSubscription` survivait à la
// session. Un membre lassé des notifications n'avait d'autre recours que les réglages du
// navigateur, ce qui coupe le site entier et se retrouve difficilement.
//
// Sans `endpoint`, on retire TOUS les appareils du membre : c'est le geste « je ne veux plus
// rien recevoir », qui ne doit pas dépendre de l'appareil depuis lequel on le fait.
export async function POST(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const { endpoint } = (await req.json().catch(() => ({}))) as { endpoint?: unknown };

  const { count } = await prisma.pushSubscription.deleteMany({
    where:
      typeof endpoint === "string" && endpoint
        ? { userId: session.userId, endpoint }
        : { userId: session.userId },
  });

  return NextResponse.json({ ok: true, removed: count });
}
