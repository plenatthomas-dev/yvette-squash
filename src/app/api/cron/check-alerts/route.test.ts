import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// Régression de sécurité : ce cron avait sa PROPRE copie de la récupération du jeton ResaMania.
// Elle passait la chaîne CHIFFRÉE en Bearer (→ 401, alerte perdue en silence) et réécrivait le
// jeton rafraîchi EN CLAIR en base — ce qui, à la visite suivante du membre, faisait échouer
// `decrypt` dans resolveResaToken et SUPPRIMAIT sa session (déconnexion forcée).
// Ces tests verrouillent le contrat : le jeton vient de session.ts, et ce cron n'écrit jamais
// sur `Session`.

const h = vi.hoisted(() => ({
  authorized: true,
  alerts: [] as Array<Record<string, unknown>>,
  resa: null as null | { accessToken: string },
  getPlanning: vi.fn(),
  sessionUpdate: vi.fn(),
  sessionFindFirst: vi.fn(),
  pushToUser: vi.fn(async () => true),
  slotAlertUpdateMany: vi.fn(),
  slotAlertUpdate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    slotAlert: {
      findMany: vi.fn(async () => h.alerts),
      updateMany: h.slotAlertUpdateMany,
      update: h.slotAlertUpdate,
    },
    session: { update: h.sessionUpdate, findFirst: h.sessionFindFirst },
  },
}));
vi.mock("@/lib/session", () => ({ getResaTokenForUser: vi.fn(async () => h.resa) }));
vi.mock("@/lib/resamania/client", () => ({ getPlanning: h.getPlanning }));
vi.mock("@/lib/push", () => ({ pushToUser: h.pushToUser, pushConfigured: () => true }));
vi.mock("@/lib/cron-auth", () => ({ cronAuthorized: () => h.authorized }));
vi.mock("@/lib/cron-run", () => ({ recordCronRun: vi.fn() }));

import { GET } from "./route";

const req = () => ({} as NextRequest);
// Un créneau demain : l'alerte ne doit pas être écartée comme « déjà passée ».
const tomorrow = () => {
  const d = new Date(Date.now() + 24 * 3600_000);
  return d.toLocaleDateString("en-CA");
};

beforeEach(() => {
  vi.clearAllMocks();
  h.authorized = true;
  h.resa = { accessToken: "jeton-en-clair-valide" };
  h.alerts = [{ id: "a1", userId: "u1", date: tomorrow(), hm: "18:00", active: true }];
  h.getPlanning.mockResolvedValue({ slots: [] });
});

describe("GET /api/cron/check-alerts — jeton ResaMania", () => {
  it("interroge le planning avec le jeton DÉCHIFFRÉ fourni par session.ts", async () => {
    await GET(req());
    expect(h.getPlanning).toHaveBeenCalledTimes(1);
    // Le 2e argument est le Bearer : il doit être le jeton en clair, jamais une chaîne chiffrée.
    expect(h.getPlanning.mock.calls[0][1]).toBe("jeton-en-clair-valide");
  });

  it("n'écrit JAMAIS sur Session (plus de persistance de jeton ici)", async () => {
    await GET(req());
    expect(h.sessionUpdate).not.toHaveBeenCalled();
    expect(h.sessionFindFirst).not.toHaveBeenCalled();
  });

  it("passe simplement l'alerte si le membre n'a plus de session ResaMania exploitable", async () => {
    h.resa = null;
    const res = await GET(req());
    expect(h.getPlanning).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("notifie quand le créneau visé est redevenu réservable", async () => {
    h.getPlanning.mockResolvedValue({
      slots: [{ startsAt: `${tomorrow()}T18:00:00+02:00`, bookable: true }],
    });
    await GET(req());
    expect(h.pushToUser).toHaveBeenCalledTimes(1);
  });

  it("refuse un appel non autorisé", async () => {
    h.authorized = false;
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(h.getPlanning).not.toHaveBeenCalled();
  });
});
