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

// Envoie une notif à TOUS les membres abonnés (annonce club, cf. espace admin). Un envoi par
// joueur ayant au moins un abonnement (pushToUser dédoublonne les appareils et purge les
// abonnements morts). Renvoie { recipients: joueurs effectivement notifiés, sent: total
// d'appareils touchés }. Best-effort : un abonnement en échec n'interrompt pas les autres.
export async function pushToAll(payload: PushPayload): Promise<{ recipients: number; sent: number }> {
  if (!ensureConfigured()) return { recipients: 0, sent: 0 };
  const subs = await prisma.pushSubscription.findMany({
    distinct: ["userId"],
    select: { userId: true },
  });
  let recipients = 0;
  let sent = 0;
  await Promise.all(
    subs.map(async ({ userId }) => {
      const n = await pushToUser(userId, payload);
      if (n > 0) {
        recipients++;
        sent += n;
      }
    }),
  );
  return { recipients, sent };
}

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
        } else {
          // Échec non lié à un abonnement mort (réseau, VAPID, quota…) : à tracer dans
          // les logs Vercel — sinon les notifications perdues sont indiagnosticables.
          console.warn(
            `[push] envoi échoué (user ${userId}, code ${code ?? "?"}) : ${(e as Error).message}`,
          );
        }
      }
    }),
  );
  return sent;
}
