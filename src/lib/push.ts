import webpush from "web-push";
import { prisma } from "./db";
import { recordNotifications } from "./notify-store";

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

export type PushPayload = {
  title: string;
  body: string;
  url?: string;
  /** Notifications de même tag : la nouvelle REMPLACE la précédente au lieu d'empiler. */
  tag?: string;
  /**
   * Alerter (son/vibration) même lorsqu'on remplace une notification de même tag. Sans cela
   * la spec impose un remplacement SILENCIEUX : une série d'événements partageant un tag ne
   * signalerait que le premier. Sans effet en l'absence de `tag`.
   */
  renotify?: boolean;
};

// Envoie une notif à TOUS les membres abonnés (annonce club, cf. espace admin). Un envoi par
// joueur ayant au moins un abonnement (pushToUser dédoublonne les appareils et purge les
// abonnements morts). Renvoie { recipients: joueurs effectivement notifiés, sent: total
// d'appareils touchés }. Best-effort : un abonnement en échec n'interrompt pas les autres.
export async function pushToAll(payload: PushPayload): Promise<{ recipients: number; sent: number }> {
  const subs = await prisma.pushSubscription.findMany({
    distinct: ["userId"],
    select: { userId: true },
  });
  // Journalisé AVANT le contrôle de configuration, et une seule fois pour tout le monde :
  // c'est justement quand le push ne peut pas partir que la cloche doit garder une trace.
  await recordNotifications(
    subs.map((s) => s.userId),
    payload,
  );
  if (!ensureConfigured()) return { recipients: 0, sent: 0 };
  let recipients = 0;
  let sent = 0;
  await Promise.all(
    subs.map(async ({ userId }) => {
      const n = await pushToUser(userId, payload, { record: false });
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
export async function pushToUser(
  userId: string,
  payload: PushPayload,
  opts: { record?: boolean } = {},
): Promise<number> {
  // Journalisé par DÉFAUT — y compris quand l'envoi échoue, c'est même là que le journal
  // sert le plus. Les appels groupés passent `record: false` et journalisent en une fois.
  if (opts.record !== false) await recordNotifications([userId], payload);
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

/**
 * Envoie une notif à une LISTE de membres. Sert au suivi interclub, où l'on ne touche que les
 * abonnés d'une équipe et d'un niveau donnés — `pushToAll` arroserait tout le club.
 *
 * Dédoublonne les ids reçus (un même membre peut remonter de plusieurs abonnements) et
 * s'appuie sur `pushToUser`, qui gère déjà les appareils multiples et purge les abonnements
 * morts. Best-effort, comme le reste du module : un envoi en échec n'interrompt pas les autres
 * et ne jette jamais.
 */
export async function pushToUsers(
  userIds: readonly string[],
  payload: PushPayload,
): Promise<{ recipients: number; sent: number }> {
  const unique = [...new Set(userIds)];
  // Journalisé pour TOUTE la liste visée, avant le contrôle de configuration et sans se
  // soucier de qui a un abonnement push. C'est le point du dispositif : un membre abonné au
  // suivi d'une équipe voit la notification dans l'appli même si son téléphone n'en reçoit
  // aucune — permission refusée, iPhone hors écran d'accueil, ou clés absentes.
  await recordNotifications(unique, payload);
  if (!ensureConfigured()) return { recipients: 0, sent: 0 };
  let recipients = 0;
  let sent = 0;
  await Promise.all(
    unique.map(async (userId) => {
      const n = await pushToUser(userId, payload, { record: false });
      if (n > 0) {
        recipients += 1;
        sent += n;
      }
    }),
  );
  return { recipients, sent };
}
