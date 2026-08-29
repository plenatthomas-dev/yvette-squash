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
let configFailed = false;
/**
 * Arme `web-push`, une fois pour toutes. Rend `false` — plutôt que de jeter — si la
 * configuration est inutilisable.
 *
 * ⚠️ `setVapidDetails` VALIDE ses arguments et LÈVE : un sujet qui n'est ni `mailto:` ni une
 * URL, une clé mal formée, et l'appel jette. Ces trois valeurs viennent de l'environnement, où
 * une main humaine les pose — `VAPID_SUBJECT=contact@club.fr`, sans le `mailto:`, suffit. Hors
 * `try`, ce module contredisait alors sa propre promesse de ne jamais jeter, et l'annonce du
 * club (`POST /api/admin/announce`, qui appelle `pushToAll` SANS ceinture) remontait un 500
 * muet — alors même que le journal était déjà écrit et l'annonce visible sous la cloche de tout
 * le monde. L'admin réessayait, et dupliquait les lignes du journal.
 */
function ensureConfigured(): boolean {
  if (configured) return true;
  if (configFailed || !PUB || !PRIV) return false;
  try {
    webpush.setVapidDetails(SUBJECT, PUB, PRIV);
  } catch (e) {
    // Une seule trace : la cause est de configuration, elle ne se corrigera pas d'elle-même et
    // chaque notification de la soirée reviendrait ici.
    configFailed = true;
    console.warn(`[push] configuration VAPID invalide, aucun envoi possible : ${(e as Error).message}`);
    return false;
  }
  configured = true;
  return true;
}

/**
 * Le serveur a-t-il RÉELLEMENT de quoi envoyer une notification ?
 *
 * C'est ce que `GET /api/interclub/follows` publie sous `pushReady`, en se présentant comme
 * « la SEULE source fiable sur ce point ». Elle ne testait que la PRÉSENCE des deux variables
 * d'environnement — jamais leur validité, et sans jamais consulter `configFailed`.
 *
 * Or `ensureConfigured` documente juste en dessous que `setVapidDetails` JETTE sur un sujet mal
 * formé, et donne comme exemple `VAPID_SUBJECT=contact@club.fr`, sans le `mailto:`. Avec cette
 * valeur les trois variables sont présentes : la route répondait `true`, le membre s'abonnait,
 * l'écran confirmait, et aucune notification ne partait jamais. C'est mot pour mot le symptôme
 * que cette réponse existe pour empêcher, à une variable d'environnement près.
 *
 * On pose donc la vraie question, celle que se posent les envois eux-mêmes. L'appel est sans
 * effet de bord observable : `ensureConfigured` est mémoïsé dans les deux sens — succès comme
 * échec définitif.
 */
export function pushConfigured(): boolean {
  return ensureConfigured();
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

// Envoie une notif à TOUS les membres (annonce club, cf. espace admin). Un envoi par joueur
// ayant au moins un abonnement (pushToUser dédoublonne les appareils et purge les abonnements
// morts). Renvoie { recipients: joueurs effectivement notifiés, sent: total d'appareils
// touchés }. Best-effort : un abonnement en échec n'interrompt pas les autres.
export async function pushToAll(payload: PushPayload): Promise<{ recipients: number; sent: number }> {
  // DEUX populations distinctes, et c'est tout l'objet de cette fonction :
  //  - `members` = qui doit VOIR l'annonce (tout le club) → alimente le journal ;
  //  - `subs`    = qui peut la RECEVOIR sur son téléphone → alimente le push.
  //
  // Les confondre — ne journaliser que les abonnés au push, comme le faisait cette fonction —
  // vidait le dispositif de son sens : un membre qui coupe ses notifications (ou ne les a
  // jamais autorisées) ne voyait plus les annonces du club NULLE PART, ni en push ni sous la
  // cloche. C'est exactement le cas que le journal existe pour couvrir, et la fonction sœur
  // `pushToUsers` faisait déjà l'inverse, à dix lignes d'ici.
  //
  // Les comptes désactivés sont exclus : ils ne peuvent plus se connecter pour lire.
  // Base injoignable → on rend un compte nul, on ne jette pas : cette fonction est appelée
  // depuis `POST /api/admin/announce`, sans ceinture, et un rejet y devenait un 500 muet.
  let members: { id: string }[];
  let subs: { userId: string }[];
  try {
    [members, subs] = await Promise.all([
      prisma.user.findMany({ where: { disabledAt: null }, select: { id: true } }),
      prisma.pushSubscription.findMany({ distinct: ["userId"], select: { userId: true } }),
    ]);
  } catch (e) {
    console.warn(`[push] destinataires illisibles, annonce non envoyée : ${(e as Error).message}`);
    return { recipients: 0, sent: 0 };
  }
  // Journalisé AVANT le contrôle de configuration, et une seule fois pour tout le monde :
  // c'est justement quand le push ne peut pas partir que la cloche doit garder une trace.
  await recordNotifications(
    members.map((m) => m.id),
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
  // Même parti pris que partout dans ce module : la base indisponible rend 0, elle ne jette
  // pas. Sans ce `try`, un `pushToUsers` d'une soirée d'interclub rejetait en bloc dès que la
  // requête d'un seul destinataire échouait, à l'intérieur du `Promise.all`.
  let subs: { id: string; endpoint: string; p256dh: string; auth: string }[];
  try {
    subs = await prisma.pushSubscription.findMany({ where: { userId } });
  } catch (e) {
    console.warn(`[push] abonnements illisibles (user ${userId}) : ${(e as Error).message}`);
    return 0;
  }
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
 * et ne jette jamais — configuration VAPID invalide et base injoignable comprises, qui étaient
 * les deux chemins par lesquels cette promesse était fausse.
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
