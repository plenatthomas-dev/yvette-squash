import { describe, it, expect, vi, beforeEach } from "vitest";

const tables = ["planningSnapshot", "appNotification", "forumMessage", "requestLog", "emailBlock", "notifDeviceState", "webauthnChallengeUse", "errorReport"] as const;
const h = vi.hoisted(() => ({ calls: {} as Record<string, unknown[]> }));
vi.mock("./db", () => {
  const prisma: Record<string, { deleteMany: (a: unknown) => Promise<{ count: number }> }> = {};
  for (const t of ["planningSnapshot", "appNotification", "forumMessage", "requestLog", "emailBlock", "notifDeviceState", "webauthnChallengeUse", "errorReport"]) {
    prisma[t] = {
      deleteMany: async (a: unknown) => {
        (h.calls[t] ??= []).push(a);
        if (t === "forumMessage") throw new Error("base");
        return { count: 2 };
      },
    };
  }
  return { prisma };
});

import { purgeRetention, purgedTotal } from "./retention-purge";

beforeEach(() => {
  h.calls = {};
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("purgeRetention — la durée annoncée est tenue même sans trafic", () => {
  it("purge chaque table, et une table en panne ne bloque pas les suivantes", async () => {
    const now = Date.parse("2026-10-17T06:00:00Z");
    const r = await purgeRetention(now);
    for (const t of tables) expect(h.calls[t]).toHaveLength(1);
    expect(r.forumMessage).toBe(0);
    expect(purgedTotal(r)).toBe(14);
  });

  it("bornes : snapshots à J-7 (date), cloche à 30 jours, fil à 12 mois", async () => {
    const now = Date.parse("2026-10-17T06:00:00Z");
    await purgeRetention(now);
    expect(h.calls.planningSnapshot[0]).toEqual({ where: { date: { lt: "2026-10-10" } } });
    const cloche = (h.calls.appNotification[0] as { where: { createdAt: { lt: Date } } }).where.createdAt.lt;
    expect(cloche.toISOString()).toBe("2026-09-17T06:00:00.000Z");
    const fil = (h.calls.forumMessage[0] as { where: { createdAt: { lt: Date } } }).where.createdAt.lt;
    expect(fil.toISOString()).toBe("2025-10-17T06:00:00.000Z");
  });
});
