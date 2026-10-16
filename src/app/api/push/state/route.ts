import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { parseNotifReport } from "@/lib/notif-state";
import { NOTIF_STATE_RETENTION_MS } from "@/lib/retention";

export const runtime = "nodejs";

// POST /api/push/state { deviceId, permission, subscribed, platform }
// Relevé de l'état des notifications de l'appareil courant — pour la MESURE du tableau de bord
// admin (combien de membres ne reçoivent rien, et pourquoi). N'abonne ni ne désabonne rien.
export async function POST(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const report = parseNotifReport(await req.json().catch(() => null));
  if (!report) {
    return NextResponse.json({ error: "Relevé invalide" }, { status: 400 });
  }
  const { deviceId, ...state } = report;
  // Le propriétaire vient de la SESSION, jamais du corps. Un appareil qui change de compte
  // change donc de propriétaire, comme un abonnement push (cf. api/push/subscribe).
  // `updatedAt` explicite : un relevé inchangé doit quand même rafraîchir la date, c'est elle
  // qui maintient l'appareil dans la fenêtre du tableau de bord.
  const now = new Date();
  await prisma.notifDeviceState.upsert({
    where: { deviceId },
    update: { userId: session.userId, ...state, updatedAt: now },
    create: { deviceId, userId: session.userId, ...state },
  });
  // Purge opportuniste (cf. lib/retention.ts) : un échec ici ne doit pas faire échouer le relevé.
  await prisma.notifDeviceState
    .deleteMany({ where: { updatedAt: { lt: new Date(now.getTime() - NOTIF_STATE_RETENTION_MS) } } })
    .catch(() => {});
  return NextResponse.json({ ok: true });
}
