"use client";

// Helpers Web Push côté navigateur : enregistrement du service worker, permission,
// abonnement, et envoi de l'abonnement au serveur. Tout est idempotent et « safe » :
// si le push n'est pas supporté ou pas configuré (clé VAPID absente), on renvoie false.

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  // Buffer alloué explicitement (ArrayBuffer, pas SharedArrayBuffer) → accepté par
  // applicationServerKey (BufferSource) sans souci de typage.
  const arr = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function pushEnabledOnServer(): boolean {
  return !!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
}

/**
 * Issue d'une demande d'activation. `dismissed` et `denied` ne se traitent PAS pareil :
 * une demande fermée sans réponse (croix, appui à côté, demande « discrète » de Chrome) peut
 * être reposée d'un simple nouvel appui ; un refus, lui, ne se lève plus que dans les
 * réglages (cf. `notif-unblock.ts`). Les confondre envoyait dans les réglages quelqu'un à qui
 * un appui suffisait.
 */
export type PushOutcome = "ok" | "denied" | "dismissed" | "failed";

// Renvoie true si l'appareil est abonné aux notifications à la sortie.
// La demande de permission n'a lieu que sur geste utilisateur (à appeler depuis un onClick).
export async function ensurePushSubscribed(): Promise<boolean> {
  return (await requestPush()) === "ok";
}

/** `ensurePushSubscribed`, en disant POURQUOI ça n'a pas marché. Peut jeter, comme elle. */
export async function requestPush(): Promise<PushOutcome> {
  if (!pushSupported()) return "failed";
  const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!key) return "failed";

  // `updateViaCache: "none"` : sans cela le navigateur peut resservir un sw.js mis en cache
  // lorsqu'il vérifie les mises à jour, et une correction du service worker — l'ajout de
  // `renotify`, par exemple — mettrait un jour à prendre effet. `update()` force la
  // vérification tout de suite plutôt qu'à la prochaine navigation.
  const reg = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
  reg.update().catch(() => {});
  await navigator.serviceWorker.ready;

  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "default") {
    const perm = await Notification.requestPermission();
    if (perm === "denied") return "denied";
    if (perm !== "granted") return "dismissed";
  }

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
  }

  if (!(await declarerAuServeur(sub))) return "failed";
  markPushWanted();
  return "ok";
}

const WANTED_KEY = "notifWanted";

/**
 * Le membre VEUT les notifications sur cet appareil : abonnement réussi, abonnement existant
 * constaté à l'ouverture, ou guide de déblocage affiché. Seul « Ne plus recevoir » l'efface.
 * C'est ce souhait — et lui seul — qui autorise `restoreWantedPush` à réabonner sans geste.
 */
export function markPushWanted(): void {
  try {
    localStorage.setItem(WANTED_KEY, "1");
  } catch {
    /* stockage indisponible : il restera les boutons « Activer » et « C'est fait » */
  }
}

let restoring: Promise<boolean> | null = null;

/**
 * Rétablit, SANS GESTE, l'abonnement d'un appareil qui l'a perdu alors que le membre le
 * voulait. Renvoie true si l'appareil vient d'être (ré)abonné.
 *
 * LE CAS QUI L'A FAIT ÉCRIRE (Pixel 8a, 14/10/2026). Couper puis rétablir les notifications de
 * l'appli dans les réglages d'Android : Chrome ne relit ce réglage qu'au LANCEMENT de l'appli
 * (un onglet Chrome sur le même site reste « bloqué » d'ici là), et il résilie l'abonnement
 * push dès que l'autorisation tombe. L'appareil revenait donc « autorisé mais non abonné » :
 * plus rien n'arrivait, sans que rien ne le dise. Même issue après le guide de déblocage.
 *
 * Silencieuse hors de ce cas : sans souhait enregistré, elle ne fait rien — un membre qui a
 * pressé « Ne plus recevoir » garde la permission accordée et ne doit pas être réabonné derrière
 * son dos. Les appels simultanés (page + panneau au même retour) partagent la même promesse.
 */
export function restoreWantedPush(): Promise<boolean> {
  restoring ??= (async () => {
    try {
      if (!pushSupported()) return false;
      if (localStorage.getItem(WANTED_KEY) !== "1") return false;
      // Bloqué : le souhait reste, pour le prochain retour. Remis à « demander » : la demande
      // exige un geste, c'est le bouton « Activer » qui le recueillera.
      if (Notification.permission !== "granted") return false;
      if ((await pushSubscriptionState()).subscribed) return false;
      return (await requestPush()) === "ok";
    } catch {
      return false;
    }
  })().finally(() => {
    restoring = null;
  });
  return restoring;
}

/**
 * Déclare au serveur que cet abonnement est celui du COMPTE CONNECTÉ.
 *
 * La route fait un `upsert` sur l'endpoint : si la ligne existait au nom d'un autre compte,
 * elle CHANGE de main. C'est tout le mécanisme sur lequel repose `syncPushSubscription`.
 */
async function declarerAuServeur(sub: PushSubscription): Promise<boolean> {
  const json = sub.toJSON();
  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint: sub.endpoint,
      keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
    }),
  });
  return res.ok;
}

/**
 * Réaffirme EN SILENCE que l'abonnement de cet appareil appartient au compte connecté.
 *
 * LE DÉFAUT QU'ELLE CORRIGE. Un abonnement push appartient à un APPAREIL — le navigateur en
 * garde un seul par origine, et il survit à tout : déconnexion, changement de compte, mois
 * d'inactivité. La table, elle, le range sous un COMPTE, celui qui était connecté au moment où
 * l'on a pressé le bouton des réglages. Rien ne remettait ensuite les deux en accord :
 * `/api/auth/logout` ne touche pas à la ligne, et `ensurePushSubscribed` n'est appelée que sur
 * un geste. Un téléphone qui change de main — ou de compte — continuait donc de recevoir les
 * notifications de l'ANCIEN membre. Symptôme visible : on écrit dans le fil, et son propre
 * message revient en notification, parce que le serveur l'adresse à l'ancien compte (qui, lui,
 * n'est pas l'auteur) et que c'est le même appareil qui le reçoit.
 *
 * Silencieuse, à trois conditions près : permission DÉJÀ accordée, worker DÉJÀ enregistré,
 * abonnement DÉJÀ pris. Elle ne demande donc jamais rien et n'abonne personne — un membre qui
 * n'a pas voulu des notifications n'en reçoit pas davantage. Elle ne fait que corriger le NOM
 * porté par une ligne qui existe.
 */
export async function syncPushSubscription(): Promise<boolean> {
  if (!pushSupported()) return false;
  // Pas `pushEnabledOnServer()` : sans clé VAPID il n'existe aucun abonnement à réaffirmer,
  // et le `getSubscription()` ci-dessous rendra `null` de lui-même.
  if (Notification.permission !== "granted") return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (!sub) return false;
    // Abonné d'avant ce drapeau : on retient qu'il veut les notifications, pour que
    // `restoreWantedPush` le réabonne si l'abonnement venait à se perdre.
    markPushWanted();
    return await declarerAuServeur(sub);
  } catch {
    // Aucune conséquence visible : au pire la ligne reste au nom de l'ancien compte jusqu'au
    // prochain chargement. Ce n'est pas un chemin dont on doive avertir le membre.
    return false;
  }
}

/**
 * L'appareil est-il DÉJÀ abonné ? Lit l'abonnement existant du service worker sans rien
 * demander à l'utilisateur — indispensable pour afficher un état plutôt qu'un bouton qui ne
 * dit pas s'il a déjà été pressé.
 */
export async function pushSubscriptionState(): Promise<{
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
}> {
  if (!pushSupported()) return { permission: "unsupported", subscribed: false };
  const permission = Notification.permission;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    return { permission, subscribed: !!sub };
  } catch {
    // Service worker indisponible (contexte non sécurisé, navigation privée) : on sait au
    // moins dire où en est la permission.
    return { permission, subscribed: false };
  }
}

/**
 * Coupe les notifications pour ce membre : on retire l'abonnement du navigateur ET les lignes
 * côté serveur. Retirer l'un sans l'autre laisserait soit des envois dans le vide, soit un
 * abonnement fantôme que rien ne viendrait purger avant sa première erreur 410.
 */
export async function unsubscribePush(): Promise<boolean> {
  // Choix explicite : plus aucun réabonnement automatique sur cet appareil.
  try {
    localStorage.removeItem(WANTED_KEY);
  } catch {
    /* stockage indisponible : aucun souhait n'a pu être enregistré non plus */
  }
  let endpoint: string | undefined;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    endpoint = sub?.endpoint;
    if (sub) await sub.unsubscribe();
  } catch {
    /* on tente quand même le retrait côté serveur */
  }
  try {
    const res = await fetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(endpoint ? { endpoint } : {}),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ferme les notifications SYSTÈME encore affichées par l'appli, et efface la pastille d'icône.
 *
 * ⚠️ LA PASTILLE DE L'ICÔNE NE LIT PAS LA CLOCHE. Sur Android, le lanceur compte les
 * notifications de l'appli toujours présentes dans le volet — pas nos lignes en base. Lire ou
 * vider la cloche laissait donc « 18 » sur l'icône, indéfiniment, tant que personne n'allait
 * balayer le volet à la main : un calendrier republié par la ligue a suffi à le montrer.
 *
 * `clearAppBadge` couvre les plateformes qui gèrent une pastille à part (bureau, iOS) ; Chrome
 * Android ne l'implémente pas, d'où la fermeture des notifications elles-mêmes, qui est ce que
 * son lanceur compte. Silencieuse : un échec ici ne doit rien interrompre.
 */
export async function clearSystemNotifications(): Promise<void> {
  if (typeof navigator === "undefined") return;
  try {
    const nav = navigator as Navigator & { clearAppBadge?: () => Promise<void> };
    await nav.clearAppBadge?.();
  } catch {
    /* non supporté ou refusé : rien à faire */
  }
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    for (const n of await reg.getNotifications()) n.close();
  } catch {
    /* pas de service worker, ou API absente : rien à fermer */
  }
}
