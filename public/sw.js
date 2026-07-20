/* Service worker minimal : notifications Web Push + handler fetch requis pour l'installabilité.
   (Pas de cache offline pour l'instant — on garde l'appli toujours fraîche.) */

// Prise de contrôle immédiate : sans ça, une nouvelle version du SW reste « en attente »
// tant qu'un ancien onglet vit, et ne contrôle pas la page au premier chargement — or Chrome
// n'émet `beforeinstallprompt` que si un SW avec handler fetch CONTRÔLE déjà la page.
self.addEventListener("install", () => {
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Handler fetch : condition d'« installabilité » PWA (sans lui, aucun prompt Android). Il ne
// fait PAS de cache offline. ATTENTION : un handler VIDE est détecté par Chrome comme « no-op »
// et ignoré (donc pas de prompt) — il doit faire quelque chose de réel. On se contente donc
// d'un passthrough réseau sur les navigations : comportement identique à sans SW, mais le
// handler est « réel » aux yeux de Chrome.
self.addEventListener("fetch", (event) => {
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request));
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "Squash de l'Yvette", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Squash de l'Yvette";
  const options = {
    body: data.body || "",
    icon: "/logo_squash.jpeg",
    badge: "/logo_squash.jpeg",
    tag: data.tag || undefined, // remplace une notif de même tag plutôt que d'empiler
    data: { url: data.url || "/" },
  };

  // Si l'appli est OUVERTE, on prévient les onglets pour qu'ils jouent le son d'alerte
  // « terrain libéré » (tag `alert-…`). Appli fermée : seule la notification système sonne.
  const isSlotFree = typeof data.tag === "string" && data.tag.startsWith("alert-");
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options);
      if (!isSlotFree) return;
      const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of list) client.postMessage({ type: "slot-free" });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((list) => {
        // Réutilise un onglet ouvert de l'appli si possible, sinon en ouvre un.
        for (const client of list) {
          if ("focus" in client) {
            client.navigate(url);
            return client.focus();
          }
        }
        return self.clients.openWindow(url);
      }),
  );
});
