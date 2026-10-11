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
//
// Seule exception : la navigation échoue faute de réseau. Sans ce `catch`, l'appli installée
// affichait la page d'erreur de Chrome (le dinosaure) ; elle affiche désormais la sienne.
self.addEventListener("fetch", (event) => {
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => pageHorsLigne()));
  }
});

// Construite ICI plutôt que mise en cache : rien à installer ni à invalider, elle ne peut pas
// être périmée. Tout y est en ligne (styles, dessin) : hors réseau, rien d'autre ne se charge.
// Statut 200 : c'est ce que Chrome attend d'une appli Android (TWA) hors ligne, ses critères
// de qualité comptant un 5xx sur la page de démarrage comme une appli cassée.
function pageHorsLigne() {
  return new Response(PAGE_HORS_LIGNE, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const PAGE_HORS_LIGNE = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f1115">
<title>Pas de connexion · Squash de l'Yvette</title>
<style>
  :root { color-scheme: light dark; --fond: #ffffff; --encre: #0f1115; --doux: #5b6170; --accent: #2f6fe0; --accent-fg: #ffffff; }
  @media (prefers-color-scheme: dark) {
    :root { --fond: #0f1115; --encre: #e8eaf0; --doux: #9aa1b2; --accent: #4f8cff; --accent-fg: #0e1116; }
  }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 24px 16px; box-sizing: border-box;
    background: var(--fond); color: var(--encre); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; text-align: center; }
  main { max-width: 22rem; }
  svg { width: 80px; height: 80px; color: var(--doux); }
  h1 { font-size: clamp(1.25rem, 5vw, 1.5rem); font-weight: 700; line-height: 1.15; margin: 12px 0 12px; }
  p { margin: 0 0 24px; color: var(--doux); }
  button { font: inherit; font-weight: 600; border: 0; border-radius: 12px; padding: 12px 32px;
    background: var(--accent); color: var(--accent-fg); cursor: pointer; }
</style>
</head>
<body>
<main>
  <svg viewBox="0 0 96 96" aria-hidden="true">
    <defs><clipPath id="tete"><ellipse cx="48" cy="29" rx="15" ry="21"/></clipPath></defs>
    <g transform="translate(-9 3) rotate(38 48 50)" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
      <g clip-path="url(#tete)" stroke-width="2.6"><path d="M41 4 V56 M48 4 V56 M55 4 V56 M28 21 H68 M28 29 H68 M28 37 H68"/></g>
      <ellipse cx="48" cy="29" rx="17" ry="23" stroke-width="6"/>
      <path d="M38 47 L48 62 L58 47" stroke-width="5"/>
      <path d="M48 62 V91" stroke-width="9"/>
    </g>
    <circle cx="84" cy="54" r="9" fill="currentColor"/>
  </svg>
  <h1>Pas de connexion</h1>
  <p>Le planning se lit en direct : l'appli a besoin d'internet pour l'afficher. Elle se recharge toute seule dès que le réseau revient.</p>
  <button type="button" onclick="location.reload()">Réessayer</button>
</main>
<script>addEventListener("online", () => location.reload());</script>
</body>
</html>`;

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
    // Le badge, c'est la petite icône de la barre d'état : Android n'en garde QUE la
    // transparence. Le logo (JPEG, fond blanc) y devenait un carré blanc ; il faut une
    // silhouette blanche sur fond transparent (source : icon-monochrome.svg).
    badge: "/icon-monochrome-96.png",
    tag: data.tag || undefined, // remplace une notif de même tag plutôt que d'empiler
    // Sans `renotify`, une notification qui en REMPLACE une autre de même tag échange son
    // contenu SANS alerter : ni son, ni vibration. Un suivi en direct qui partage un tag
    // pour tenir sur une seule ligne deviendrait alors muet dès la deuxième notification.
    // Les émetteurs qui veulent être entendus à chaque fois le demandent explicitement.
    renotify: !!data.renotify && !!data.tag,
    // Boutons « Réserver », « Dispo »… : exécutés plus bas (`notificationclick`), sans ouvrir
    // l'appli. `data.data` porte ce qu'il leur faut, `data.to` le destinataire (cf. push.ts).
    actions: Array.isArray(data.actions) ? data.actions : [],
    data: { ...(data.data && typeof data.data === "object" ? data.data : {}), url: data.url || "/", to: data.to },
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
  const n = event.notification;
  const d = n.data || {};
  n.close();
  // Les boutons agissent SANS ouvrir l'appli : c'est tout leur intérêt. Les noms d'action
  // viennent de src/lib/notification-actions.ts, à changer ensemble.
  if (event.action === "book" && d.book) {
    event.waitUntil(reserver(n, d));
    return;
  }
  if ((event.action === "avail-yes" || event.action === "avail-no") && d.fixtureId) {
    event.waitUntil(repondreDispo(n, d, event.action === "avail-yes" ? "yes" : "no"));
    return;
  }
  event.waitUntil(ouvrir(d.url || "/"));
});

function ouvrir(url) {
  return self.clients
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
    });
}

// Le résultat d'un bouton REMPLACE la notification d'origine (même tag) : une seule ligne,
// qui dit ce qui s'est passé, et qu'un toucher ouvre à l'endroit concerné. `enCours` : l'étape
// d'attente, affichée en silence — la réponse, elle, se fait entendre.
function signaler(tag, title, body, url, enCours) {
  return self.registration.showNotification(title, {
    body,
    icon: "/logo_squash.jpeg",
    badge: "/icon-monochrome-96.png",
    tag,
    renotify: !enCours,
    silent: !!enCours,
    data: { url },
  });
}

// Appel d'API avec les cookies de l'appareil (même origine). `status: 0` = pas de réseau.
async function appeler(url, method, body) {
  try {
    const res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json: json || {} };
  } catch (e) {
    return { status: 0, json: {} };
  }
}

// Les messages des routes sont déjà écrits pour le membre : on les montre tels quels.
function messageEchec(r, defaut) {
  if (!r) return defaut;
  if (r.status === 0) return "Pas de réseau : ouvre l'appli pour réessayer.";
  if (r.status === 401) return "Ta session a expiré : ouvre l'appli pour te reconnecter.";
  return typeof r.json.error === "string" && r.json.error ? r.json.error : defaut;
}

// « Réserver » : sans confirmation, c'est le geste que la notification réclame. Les terrains
// libres au moment de l'envoi sont essayés dans l'ordre, le premier ayant pu partir entre-temps.
async function reserver(n, d) {
  const b = d.book;
  const tag = n.tag || "reservation";
  const url = d.url || "/";
  if (!(Date.parse(b.startsAt) > Date.now())) {
    return signaler(tag, "Trop tard", `Le créneau du ${b.quand} a déjà commencé.`, url);
  }
  await signaler(tag, "Réservation en cours…", b.quand, url, true);
  let dernier = null;
  for (const court of Array.isArray(b.courts) ? b.courts : []) {
    const r = await appeler("/api/book", "POST", {
      classEventId: court.id,
      startsAt: b.startsAt,
      forUserId: d.to,
    });
    if (r.status === 200 && r.json.ok) {
      return signaler(tag, "Terrain réservé ✅", `${court.name} — ${b.quand}`, url);
    }
    dernier = r;
    // Un 409 SANS code vise CE terrain (pris entre-temps, retiré du planning) : au suivant.
    // Le reste vaut pour tous les terrains — session, chevauchement, autre compte, appli
    // fermée, réseau — et les essayer un à un ne ferait que répéter le refus.
    if (r.status !== 409 || r.json.code) break;
  }
  return signaler(
    tag,
    "Réservation impossible",
    messageEchec(dernier, "Plus aucun terrain libre à cet horaire."),
    url,
  );
}

// « Dispo » / « Pas dispo » : la propre réponse du membre, par la route de l'écran.
async function repondreDispo(n, d, status) {
  const tag = n.tag || "interclub";
  const url = d.url || "/?view=interclub";
  await signaler(tag, n.title, "Envoi de ta réponse…", url, true);
  const r = await appeler(`/api/interclub/${encodeURIComponent(d.fixtureId)}/availability`, "PUT", {
    status,
    forUserId: d.to,
  });
  if (r.status === 200) {
    return signaler(
      tag,
      n.title,
      status === "yes" ? "C'est noté : disponible ✅" : "C'est noté : pas disponible.",
      url,
    );
  }
  // `confirm_override` est un code, pas une phrase : la route attend une confirmation que
  // seul l'écran sait demander.
  const message =
    r.status === 409 && r.json.error === "confirm_override"
      ? "Une réponse a déjà été donnée pour toi : ouvre l'appli pour la remplacer."
      : messageEchec(r, "Réponse non enregistrée : ouvre l'appli pour répondre.");
  return signaler(tag, n.title, message, url);
}
