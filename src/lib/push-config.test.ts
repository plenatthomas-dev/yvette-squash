import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// « LE SERVEUR A-T-IL DE QUOI ENVOYER ? » — la présence des clés ne répond pas à cette question.
//
// `GET /api/interclub/follows` publie cette réponse sous `pushReady` en se présentant comme « la
// SEULE source fiable sur ce point », et l'écran d'abonnement s'en sert pour dire au membre si
// ses notifications pourront arriver. Elle ne regardait que la PRÉSENCE de deux variables
// d'environnement.
//
// Or `setVapidDetails` valide ses arguments et JETTE — un `VAPID_SUBJECT` sans `mailto:` suffit,
// et c'est l'exemple que `push.ts` donne lui-même. Les trois variables étaient alors présentes,
// la route répondait `true`, le membre s'abonnait, l'écran confirmait, et rien ne partait jamais.
//
// Ce fichier charge le module à neuf pour chaque cas : `configured` et `configFailed` sont des
// états de MODULE, et c'est justement leur persistance qu'on vérifie au troisième test.

/** Charge `push.ts` avec un `web-push` qui accepte ou refuse la configuration. */
async function chargePush(refuse: boolean) {
  vi.resetModules();
  const setVapidDetails = vi.fn(() => {
    if (refuse) throw new Error("Vapid subject is not a url or mailto url");
  });
  vi.doMock("web-push", () => ({
    default: { setVapidDetails, sendNotification: vi.fn(async () => ({})) },
  }));
  vi.doMock("./db", () => ({ prisma: {} }));
  vi.doMock("./notify-store", () => ({ recordNotifications: vi.fn(async () => {}) }));
  const mod = await import("./push");
  return { ...mod, setVapidDetails };
}

beforeEach(() => {
  // Les clés sont PRÉSENTES dans tous les cas : c'est tout l'objet de ces tests.
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = "cle-publique";
  process.env.VAPID_PRIVATE_KEY = "cle-privee";
  // La trace d'une configuration invalide est voulue, mais elle n'a rien à faire dans la sortie.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("web-push");
});

describe("pushConfigured — la présence des clés ne prouve rien", () => {
  it("rend true quand la configuration est réellement utilisable", async () => {
    const { pushConfigured } = await chargePush(false);
    expect(pushConfigured()).toBe(true);
  });

  it("rend FALSE quand les clés sont là mais que la configuration est refusée", async () => {
    // `VAPID_SUBJECT=contact@club.fr`, sans le `mailto:` — l'exemple donné par `push.ts`.
    const { pushConfigured } = await chargePush(true);
    expect(pushConfigured()).toBe(false);
  });

  it("ne réessaie pas indéfiniment : l'échec est retenu", async () => {
    // La cause est de configuration, elle ne se corrigera pas d'elle-même, et chaque
    // notification de la soirée repasserait sinon par le même refus — et la même trace.
    const { pushConfigured, setVapidDetails } = await chargePush(true);
    pushConfigured();
    pushConfigured();
    pushConfigured();
    expect(setVapidDetails).toHaveBeenCalledTimes(1);
  });

  it("rend false, sans jamais jeter, quand une clé manque tout simplement", async () => {
    delete process.env.VAPID_PRIVATE_KEY;
    const { pushConfigured } = await chargePush(false);
    expect(pushConfigured()).toBe(false);
  });
});
