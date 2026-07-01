/* Service worker minimal : uniquement les notifications Web Push.
   (Pas de cache offline pour l'instant — on garde l'appli toujours fraîche.) */

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
  event.waitUntil(self.registration.showNotification(title, options));
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
