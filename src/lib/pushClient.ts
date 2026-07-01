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

// Renvoie true si l'appareil est abonné aux notifications à la sortie.
// La demande de permission n'a lieu que sur geste utilisateur (à appeler depuis un onClick).
export async function ensurePushSubscribed(): Promise<boolean> {
  if (!pushSupported()) return false;
  const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!key) return false;

  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;

  if (Notification.permission === "denied") return false;
  if (Notification.permission === "default") {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return false;
  }

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
  }

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
