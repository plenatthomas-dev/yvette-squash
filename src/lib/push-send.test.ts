import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// CE QUE `web-push` REÇOIT À CHAQUE ENVOI.
//
// Appelé sans options, `sendNotification` pose TTL = QUATRE SEMAINES (DEFAULT_TTL de
// web-push-lib.js), une urgence normale et AUCUN délai de socket. Un téléphone rallumé après un
// mois recevait des notifications périmées, et un service push muet tenait l'envoi — donc la
// route appelante — jusqu'au `maxDuration` de la fonction.
//
// Fichier à part de push.test.ts : celui-ci a besoin de clés VAPID présentes AU CHARGEMENT du
// module (elles sont lues en constantes), celui-là vérifie justement le cas sans clés.

const h = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = "cle-publique";
  process.env.VAPID_PRIVATE_KEY = "cle-privee";
  return {
    sendNotification: vi.fn(async (..._args: unknown[]) => ({})),
    recorded: [] as unknown[],
  };
});

vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: h.sendNotification },
}));
vi.mock("./db", () => ({
  prisma: {
    pushSubscription: {
      findMany: vi.fn(async () => [
        { id: "s1", userId: "u1", endpoint: "https://fcm.googleapis.com/fcm/send/x", p256dh: "p", auth: "a" },
      ]),
      delete: vi.fn(async () => ({})),
    },
  },
}));
vi.mock("./notify-store", () => ({
  recordNotifications: vi.fn(async (_ids: string[], n: unknown) => {
    h.recorded.push(n);
  }),
}));

import { pushToUser, pushToUsers } from "./push";

// Le module est déjà chargé avec les clés : on les retire pour ne pas les laisser aux fichiers
// de test qui partageraient ce processus (push.test.ts teste justement leur ABSENCE).
afterAll(() => {
  delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
});

beforeEach(() => {
  h.sendNotification.mockClear();
  h.recorded = [];
});

const options = () => h.sendNotification.mock.calls[0][2] as Record<string, unknown>;
const charge = () => JSON.parse(h.sendNotification.mock.calls[0][1] as string);

describe("envoi web-push — durée de vie, urgence, délai", () => {
  it("par défaut : TTL 24 h, urgence normale, délai de 10 s", async () => {
    await pushToUser("u1", { title: "t", body: "b" });
    expect(options()).toEqual({ TTL: 86_400, urgency: "normal", timeout: 10_000 });
  });

  it("honore `ttl` et `urgency` fournis par l'appelant", async () => {
    await pushToUser("u1", { title: "t", body: "b", ttl: 300, urgency: "high" });
    expect(options()).toEqual({ TTL: 300, urgency: "high", timeout: 10_000 });
  });

  it("vaut aussi pour les envois groupés", async () => {
    await pushToUsers(["u1"], { title: "t", body: "b", ttl: 120 });
    expect(options()).toMatchObject({ TTL: 120, urgency: "normal", timeout: 10_000 });
  });

  it("`ttl` et `urgency` ne partent PAS dans la charge utile du service worker", async () => {
    await pushToUser("u1", { title: "t", body: "b", ttl: 300, urgency: "high" });
    const p = charge();
    expect(p).not.toHaveProperty("ttl");
    expect(p).not.toHaveProperty("urgency");
    expect(p).toMatchObject({ title: "t", body: "b", to: "u1" });
  });
});
