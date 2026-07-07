import webpush from "web-push";
import { prisma } from "./db";

// Clés VAPID (à générer une fois : `npx web-push generate-vapid-keys`).
//  - NEXT_PUBLIC_VAPID_PUBLIC_KEY : publique, aussi lue côté client pour s'abonner.
//  - VAPID_PRIVATE_KEY            : privée, serveur uniquement.
//  - VAPID_SUBJECT                : "mailto:…" de contact (requis par le protocole).
const PUB = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const PRIV = process.env.VAPID_PRIVATE_KEY;
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:squash-yvette@example.com";

let configured = false;
function ensureConfigured(): boolean {
  if (configured) return true;
  if (!PUB || !PRIV) return false;
  webpush.setVapidDetails(SUBJECT, PUB, PRIV);
  configured = true;
  return true;
}

export function pushConfigured(): boolean {
  return !!(PUB && PRIV);
}

export type PushPayload = { title: string; body: string; url?: string; tag?: string };

// Envoie une notif à tous les abonnements d'un joueur.
// Supprime au passage les abonnements devenus invalides (404/410). Renvoie le nb d'envois OK.
export async function pushToUser(userId: string, payload: PushPayload): Promise<number> {
  if (!ensureConfigured()) return 0;
  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  let sent = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
        );
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) {
          await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
        }
      }
    }),
  );
  return sent;
}
