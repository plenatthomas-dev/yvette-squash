import { describe, it, expect, beforeEach, vi } from "vitest";

// Ce qui est éprouvé ici : QUI est journalisé sous la cloche, et qui reçoit un push.
//
// Ce sont deux populations différentes, et les confondre est précisément le défaut que ces
// tests verrouillent : `pushToAll` dérivait sa liste de journalisation de la table
// `PushSubscription`, si bien qu'un membre sans abonnement — ou qui venait de couper ses
// notifications — ne voyait plus les annonces du club NULLE PART. Le journal existe justement
// pour le cas où le push ne part pas.

const h = vi.hoisted(() => ({
  members: [] as Array<{ id: string }>,
  subs: [] as Array<{ userId: string }>,
  /** Ce que `recordNotifications` a reçu : la liste des membres à journaliser. */
  recorded: null as null | string[],
  memberWhere: null as null | Record<string, unknown>,
}));

vi.mock("./db", () => ({
  prisma: {
    user: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        h.memberWhere = args.where;
        return h.members;
      }),
    },
    pushSubscription: {
      findMany: vi.fn(async () => h.subs),
      delete: vi.fn(async () => ({})),
    },
  },
}));
vi.mock("./notify-store", () => ({
  recordNotifications: vi.fn(async (ids: string[]) => {
    h.recorded = [...ids];
  }),
}));
// Sans clés VAPID configurées, `ensureConfigured()` rend false et l'envoi s'arrête APRÈS la
// journalisation — c'est exactement l'ordre que ces tests veulent vérifier.
vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: vi.fn(async () => ({})) },
}));

import { pushToAll, pushToUsers } from "./push";

const payload = { title: "Terrain fermé samedi", body: "Travaux au club." };

beforeEach(() => {
  h.members = [{ id: "u1" }, { id: "u2" }, { id: "u3" }];
  h.subs = [{ userId: "u1" }];
  h.recorded = null;
  h.memberWhere = null;
});

describe("pushToAll", () => {
  it("journalise TOUT le club, et pas seulement les abonnés au push", async () => {
    await pushToAll(payload);
    expect(h.recorded).toEqual(["u1", "u2", "u3"]);
  });

  // Le cas concret : quelqu'un coupe ses notifications depuis les réglages, ce qui supprime
  // ses lignes `PushSubscription`. Il doit continuer à voir les annonces sous la cloche.
  it("journalise un membre qui vient de couper ses notifications", async () => {
    h.subs = [];
    await pushToAll(payload);
    expect(h.recorded).toEqual(["u1", "u2", "u3"]);
  });

  it("exclut les comptes désactivés : ils ne peuvent plus se connecter pour lire", async () => {
    await pushToAll(payload);
    expect(h.memberWhere).toEqual({ disabledAt: null });
  });

  it("journalise même sans clés VAPID — c'est là que le journal sert le plus", async () => {
    const res = await pushToAll(payload);
    expect(h.recorded).toHaveLength(3);
    expect(res).toEqual({ recipients: 0, sent: 0 });
  });
});

describe("pushToUsers", () => {
  it("journalise toute la liste visée, sans se soucier des abonnements", async () => {
    await pushToUsers(["a", "b"], payload);
    expect(h.recorded).toEqual(["a", "b"]);
  });

  it("dédoublonne les ids reçus", async () => {
    await pushToUsers(["a", "a", "b"], payload);
    expect(h.recorded).toEqual(["a", "b"]);
  });
});
