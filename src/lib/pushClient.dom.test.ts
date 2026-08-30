import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ensurePushSubscribed, pushSubscriptionState, pushSupported, unsubscribePush } from "./pushClient";

// L'ABONNEMENT AUX NOTIFICATIONS, MESURÉ AILLEURS QUE DANS UN MOCK DE LUI-MÊME.
//
// `InterclubFollow.dom.test.tsx` est le seul test qui croise ce module — et il le MOCKE. Ce
// qu'il vérifie, c'est que l'écran l'appelle ; ce que fait l'appel n'avait jamais été exécuté.
//
// Or c'est ici que se jouent les échecs les plus silencieux de la fonctionnalité : un membre
// qui croit s'être abonné et ne recevra jamais rien. Les promesses de ce module se lisent
// toutes en négatif — ce qu'il NE fait PAS quand la permission est refusée, ce qu'il ne
// redemande pas, ce qu'il ne laisse pas derrière lui — et un test est le seul endroit où l'on
// peut vérifier qu'une chose n'a pas eu lieu.
//
// La clé VAPID : `process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY` est inlinée AU BUILD en production,
// mais reste une variable ordinaire sous vitest — on peut donc la poser et la retirer.

const CLE = "dGVzdA"; // base64url décodable par `atob`, c'est tout ce qu'exige le module

type Sub = {
  endpoint: string;
  toJSON: () => { keys?: { p256dh?: string; auth?: string } };
  unsubscribe: ReturnType<typeof vi.fn>;
};

let registre: {
  register: ReturnType<typeof vi.fn>;
  getRegistration: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  getSubscription: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
};
let requestPermission: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

function abonnement(endpoint = "https://push.example/abc"): Sub {
  return {
    endpoint,
    toJSON: () => ({ keys: { p256dh: "P", auth: "A" } }),
    unsubscribe: vi.fn(async () => true),
  };
}

/** Installe un navigateur qui sait faire du push. `null` en abonnement = aucun encore. */
function navigateurCapable(opts: {
  permission?: NotificationPermission;
  abonnement?: Sub | null;
  registrationAbsente?: boolean;
  serviceWorkerJette?: boolean;
}) {
  const getSubscription = vi.fn(async () => opts.abonnement ?? null);
  const subscribe = vi.fn(async () => opts.abonnement ?? abonnement());
  const update = vi.fn(async () => {});
  const reg = { pushManager: { getSubscription, subscribe }, update };

  const register = vi.fn(async () => reg);
  const getRegistration = vi.fn(async () => {
    if (opts.serviceWorkerJette) throw new Error("contexte non sécurisé");
    return opts.registrationAbsente ? null : reg;
  });

  registre = { register, getRegistration, update, getSubscription, subscribe };

  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register, getRegistration, ready: Promise.resolve(reg) },
  });

  requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  vi.stubGlobal("Notification", {
    permission: opts.permission ?? "granted",
    requestPermission,
  });
  vi.stubGlobal("PushManager", class {});
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = CLE;
  fetchMock = vi.fn(async () => ({ ok: true }) as Response);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("pushSupported", () => {
  it("dit non sur un navigateur qui n'a ni service worker ni PushManager", () => {
    // C'est l'état de départ de jsdom, et celui d'un iPhone hors écran d'accueil.
    expect(pushSupported()).toBe(false);
  });

  it("dit oui quand les trois pièces sont là", () => {
    navigateurCapable({});
    expect(pushSupported()).toBe(true);
  });
});

describe("ensurePushSubscribed", () => {
  it("renonce SANS RIEN TOUCHER quand le push n'est pas supporté", async () => {
    expect(await ensurePushSubscribed()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renonce quand le serveur n'a pas de clé VAPID, avant même d'enregistrer le worker", async () => {
    // Sans clé, l'abonnement obtenu serait inutilisable : le demander ferait apparaître la
    // popup système du navigateur pour rien — et une permission refusée ne se redemande pas.
    navigateurCapable({});
    delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    expect(await ensurePushSubscribed()).toBe(false);
    expect(registre.register).not.toHaveBeenCalled();
  });

  it("enregistre le worker en COURT-CIRCUITANT le cache, et force la vérification", async () => {
    // Sans `updateViaCache: "none"`, le navigateur peut resservir un `sw.js` en cache : une
    // correction du service worker — l'ajout de `renotify`, par exemple — mettrait un jour à
    // prendre effet. `update()` force la vérification tout de suite.
    navigateurCapable({ abonnement: abonnement() });
    await ensurePushSubscribed();
    expect(registre.register).toHaveBeenCalledWith("/sw.js", { updateViaCache: "none" });
    expect(registre.update).toHaveBeenCalled();
  });

  it("NE REDEMANDE PAS une permission refusée", async () => {
    // Un refus est définitif côté navigateur : redemander ne montre rien à l'utilisateur et
    // ferait croire à l'appli qu'elle a posé la question.
    navigateurCapable({ permission: "denied" });
    expect(await ensurePushSubscribed()).toBe(false);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("demande la permission quand elle n'a jamais été posée, et s'arrête si on la refuse", async () => {
    navigateurCapable({ permission: "default" });
    requestPermission.mockResolvedValue("denied");
    expect(await ensurePushSubscribed()).toBe(false);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(registre.subscribe).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("réutilise l'abonnement existant plutôt que d'en créer un second", async () => {
    // Deux abonnements pour un même appareil, c'est deux notifications par événement.
    navigateurCapable({ abonnement: abonnement() });
    await ensurePushSubscribed();
    expect(registre.subscribe).not.toHaveBeenCalled();
  });

  it("s'abonne quand il n'y a rien, et envoie endpoint ET clés au serveur", async () => {
    navigateurCapable({ abonnement: null });
    expect(await ensurePushSubscribed()).toBe(true);
    expect(registre.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/push/subscribe");
    expect(JSON.parse(init.body as string)).toEqual({
      endpoint: "https://push.example/abc",
      keys: { p256dh: "P", auth: "A" },
    });
  });

  it("rend FAUX si le serveur refuse l'abonnement — l'appareil n'est pas abonné pour autant", async () => {
    // La valeur de retour est ce que l'écran affiche. Rendre `true` sur un serveur qui a refusé
    // afficherait « abonné » à quelqu'un que la base ne connaît pas : l'abonnement fantôme.
    navigateurCapable({ abonnement: abonnement() });
    fetchMock.mockResolvedValue({ ok: false } as Response);
    expect(await ensurePushSubscribed()).toBe(false);
  });
});

describe("pushSubscriptionState", () => {
  it("dit « unsupported » plutôt que « pas abonné » quand le navigateur ne sait pas faire", async () => {
    // Deux situations qu'un booléen confondrait, et qui appellent deux écrans différents :
    // « ton navigateur ne peut pas » et « tu n'as pas encore accepté ».
    expect(await pushSubscriptionState()).toEqual({ permission: "unsupported", subscribed: false });
  });

  it("rend la permission ET l'état d'abonnement, sans rien demander à l'utilisateur", async () => {
    navigateurCapable({ permission: "granted", abonnement: abonnement() });
    expect(await pushSubscriptionState()).toEqual({ permission: "granted", subscribed: true });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("sait dire « pas abonné » quand aucun worker n'est enregistré", async () => {
    navigateurCapable({ permission: "default", registrationAbsente: true });
    expect(await pushSubscriptionState()).toEqual({ permission: "default", subscribed: false });
  });

  it("garde la permission même quand le service worker est indisponible", async () => {
    // Navigation privée, contexte non sécurisé : on ne sait plus rien de l'abonnement, mais la
    // permission reste une information utile à l'écran.
    navigateurCapable({ permission: "denied", serviceWorkerJette: true });
    expect(await pushSubscriptionState()).toEqual({ permission: "denied", subscribed: false });
  });
});

describe("unsubscribePush", () => {
  it("retire l'abonnement du navigateur ET la ligne du serveur", async () => {
    // Retirer l'un sans l'autre laisse soit des envois dans le vide, soit un abonnement fantôme
    // que rien ne purgera avant sa première erreur 410.
    const sub = abonnement();
    navigateurCapable({ abonnement: sub });
    expect(await unsubscribePush()).toBe(true);
    expect(sub.unsubscribe).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/push/unsubscribe");
    expect(JSON.parse(init.body as string)).toEqual({ endpoint: sub.endpoint });
  });

  it("appelle QUAND MÊME le serveur si le navigateur ne rend pas l'abonnement", async () => {
    // C'est le cas qui compte : sans cela, un membre dont le worker a disparu resterait abonné
    // côté serveur pour toujours, sans aucun moyen de se désabonner depuis l'appli.
    navigateurCapable({ serviceWorkerJette: true });
    expect(await unsubscribePush()).toBe(true);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({});
  });

  it("rend FAUX quand le serveur est injoignable", async () => {
    navigateurCapable({ abonnement: abonnement() });
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await unsubscribePush()).toBe(false);
  });
});
