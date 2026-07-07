import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

// Bornes d'un abonnement Web Push : l'endpoint est une URL https (le plus souvent
// < 512 caractères), les clés sont de courtes chaînes base64url. On borne et on type
// tout pour éviter qu'un client authentifié stocke des chaînes géantes (abus de
// stockage) ou un endpoint fantaisiste (ni https, ni URL de service push).
const MAX_ENDPOINT_LEN = 1024;
const MAX_KEY_LEN = 256;

// POST /api/push/subscribe { endpoint, keys: { p256dh, auth } }
// Enregistre (ou met à jour) l'abonnement Web Push de l'appareil courant.
export async function POST(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { endpoint, keys } = (await req.json().catch(() => ({}))) as {
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
  };
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;
  if (
    typeof endpoint !== "string" ||
    !endpoint.startsWith("https://") ||
    endpoint.length > MAX_ENDPOINT_LEN ||
    typeof p256dh !== "string" ||
    p256dh.length === 0 ||
    p256dh.length > MAX_KEY_LEN ||
    typeof auth !== "string" ||
    auth.length === 0 ||
    auth.length > MAX_KEY_LEN
  ) {
    return NextResponse.json({ error: "Abonnement invalide" }, { status: 400 });
  }

  // Un endpoint identifie UN navigateur/appareil (clé unique). S'il est déjà rattaché à
  // un autre compte, c'est un appareil qui change de main (ancien membre déconnecté,
  // nouveau connecté) : on le TRANSFÈRE au compte courant. Rejeter serait pire — l'appareil
  // continuerait de recevoir les notifs de l'ancien compte et aucune du nouveau. L'endpoint
  // n'est jamais exposé par l'appli à d'autres clients (écrit ici, lu seulement côté serveur
  // par le cron) → risque de détournement à distance marginal.
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    update: { userId: session.userId, p256dh, auth },
    create: { userId: session.userId, endpoint, p256dh, auth },
  });
  return NextResponse.json({ ok: true });
}
