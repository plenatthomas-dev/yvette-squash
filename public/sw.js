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
    // Sans `renotify`, une notification qui en REMPLACE une autre de même tag échange son
    // contenu SANS alerter : ni son, ni vibration. Un suivi en direct qui partage un tag
    // pour tenir sur une seule ligne deviendrait alors muet dès la deuxième notification.
    // Les émetteurs qui veulent être entendus à chaque fois le demandent explicitement.
    renotify: !!data.renotify && !!data.tag,
    data: { url: data.url || "/" },
  };

  // Deux messages distincts aux onglets ouverts :
  //  * « slot-free » (tag `alert-…`) déclenche le son d'alerte — appli fermée, c'est la
  //    notification système qui sonne, le navigateur ne nous laisse pas jouer le nôtre ;
  //  * « push-received » est envoyé pour TOUT push, afin que la cloche se mette à jour sans
  //    attendre un rechargement. Il sert aussi de témoin : s'il arrive alors qu'aucune
  //    notification ne s'affiche, c'est que le push atteint bien le navigateur et que le
  //    blocage est dans l'affichage système.
  const isSlotFree = typeof data.tag === "string" && data.tag.startsWith("alert-");
  event.waitUntil(
    (async () => {
      // Le signal aux onglets part AVANT l'affichage : si `showNotification` échoue — option
      // refusée, permission révoquée entre-temps —, la cloche doit quand même se rafraîchir.
      const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of list) client.postMessage({ type: "push-received", tag: data.tag });
      if (isSlotFree) for (const client of list) client.postMessage({ type: "slot-free" });
      await self.registration.showNotification(title, options);
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
