import Pusher from "pusher";

// LE COURTIER TEMPS RÉEL — côté serveur.
//
// Le fil n'a PAS BESOIN de ce module pour fonctionner. C'est le point le plus important du
// fichier : Postgres reste la source de vérité, le push web reste le canal de notification, et
// `onForeground` reste le rattrapage. Pusher n'ajoute que l'immédiateté quand l'appli est
// ouverte. Clés absentes (développement, prod tant que la fonction est en essai), quota
// dépassé, panne du courtier : le fil doit continuer à marcher, en silence et sans écran
// d'erreur. D'où le contrat de ce module, copié sur celui de `push.ts` :
//
//   ⚠️ AUCUNE FONCTION D'ICI NE JETTE, JAMAIS.
//
// Cluster `eu` (Irlande) : la note de confidentialité promet un hébergement dans l'Union, et
// le cluster se choisit à la CRÉATION de l'application Pusher — il ne se change plus après.
//
// Ce qui transite par le courtier, et ce qui n'y transite pas :
//   * « message »       : émis par le SERVEUR, après l'écriture en base. Copie, pas original.
//   * « client-typing » : émis par les NAVIGATEURS entre eux, jamais vu d'ici. Pusher n'accepte
//                         les événements clients que sur un canal `private-`/`presence-`, ce
//                         qui tombe bien : on veut la présence de toute façon.
//   * la présence       : c'est l'appartenance au canal, pas une donnée qu'on écrit.

/** Le canal unique du fil. `presence-` est exigé par Pusher pour la présence ET les `client-`. */
export const FORUM_CHANNEL = "presence-forum";
/** Nom de l'événement portant un message. */
export const FORUM_EVENT_MESSAGE = "message";
/** Nom de l'événement portant une suppression, pour que le fil se referme chez tout le monde. */
export const FORUM_EVENT_DELETED = "deleted";

let client: Pusher | null = null;
let configFailed = false;

/**
 * Instancie le client au premier besoin, une seule fois — succès comme échec sont mémorisés,
 * pour ne pas relire l'environnement à chaque message. Même forme qu'`ensureConfigured` dans
 * push.ts, et pour la même raison.
 */
function broker(): Pusher | null {
  if (client) return client;
  if (configFailed) return null;
  const appId = process.env.PUSHER_APP_ID;
  const key = process.env.NEXT_PUBLIC_PUSHER_KEY;
  const secret = process.env.PUSHER_SECRET;
  const cluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;
  if (!appId || !key || !secret || !cluster) {
    configFailed = true;
    return null;
  }
  try {
    client = new Pusher({ appId, key, secret, cluster, useTLS: true });
    return client;
  } catch {
    configFailed = true;
    return null;
  }
}

/** Le courtier est-il utilisable ? Sert à l'écran pour ne pas promettre ce qu'il n'aura pas. */
export function realtimeConfigured(): boolean {
  return broker() !== null;
}

/**
 * Signe l'accès d'un membre au canal du fil.
 *
 * `userInfo` est VISIBLE DE TOUS LES ABONNÉS — c'est le principe même d'un canal de présence.
 * N'y mettre que ce que l'annuaire expose déjà : un identifiant et un nom d'affichage. Jamais
 * d'e-mail, jamais de `contactId`.
 *
 * Rend `null` si le courtier n'est pas configuré : l'appelant répond alors « pas de temps
 * réel ici » et l'écran s'en passe.
 */
export function authorizeForumChannel(
  socketId: string,
  channel: string,
  user: { id: string; name: string },
): { auth: string; channel_data?: string } | null {
  const p = broker();
  if (!p || channel !== FORUM_CHANNEL) return null;
  try {
    return p.authorizeChannel(socketId, channel, {
      user_id: user.id,
      user_info: { name: user.name },
    });
  } catch {
    return null;
  }
}

/**
 * Diffuse un événement sur le fil. Best-effort intégral : ni attente bloquante côté appelant,
 * ni erreur remontée. Un message écrit en base et non diffusé apparaîtra au prochain
 * rafraîchissement — un message diffusé mais non écrit n'existerait nulle part, et c'est pour
 * cela que l'écriture passe TOUJOURS en premier.
 */
export async function broadcastForum(event: string, payload: unknown): Promise<void> {
  const p = broker();
  if (!p) return;
  try {
    await p.trigger(FORUM_CHANNEL, event, payload);
  } catch {
    /* le fil marche sans : rien à signaler à l'utilisateur */
  }
}

/** Réinitialise la mémoïsation. Réservé aux tests, qui changent l'environnement en cours de route. */
export function resetForumRealtimeForTests(): void {
  client = null;
  configFailed = false;
}
