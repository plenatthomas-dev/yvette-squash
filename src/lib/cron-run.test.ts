import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ upsert: vi.fn() }));
vi.mock("./db", () => ({ prisma: { cronRun: { upsert: h.upsert, findMany: vi.fn() } } }));

import { runCron, cronHealth } from "./cron-run";

beforeEach(() => h.upsert.mockReset().mockResolvedValue({}));

describe("runCron — une exception laisse une trace", () => {
  it("rend le résultat du corps sans rien écrire de plus", async () => {
    await expect(runCron("x", async () => 42)).resolves.toBe(42);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("écrit ok: false puis relance l'erreur", async () => {
    await expect(runCron("warm-planning", async () => { throw new Error("boum"); })).rejects.toThrow("boum");
    expect(h.upsert).toHaveBeenCalledOnce();
    const arg = h.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ name: "warm-planning" });
    expect(arg.update).toMatchObject({ ok: false, info: "exception : boum" });
  });
});

describe("cronHealth — repère les crons en retard", () => {
  const now = Date.parse("2026-10-17T12:00:00Z");
  const cad = { quotidien: 26 * 3_600_000, hebdo: 8 * 86_400_000 };

  it("dans les temps → pas en retard ; trop vieux → en retard", () => {
    const res = cronHealth(
      [
        { name: "quotidien", lastRunAt: new Date(now - 3_600_000), ok: true, info: null },
        { name: "hebdo", lastRunAt: new Date(now - 9 * 86_400_000), ok: true, info: null },
      ],
      now,
      cad,
    );
    expect(res.map((r) => [r.name, r.late])).toEqual([["hebdo", true], ["quotidien", false]]);
  });

  it("un cron attendu qui n'a jamais écrit apparaît, en retard", () => {
    const res = cronHealth([], now, cad);
    expect(res).toHaveLength(2);
    expect(res.every((r) => r.late && !r.ok && r.lastRunAt === null)).toBe(true);
  });

  it("un cron hors table n'est jamais « en retard »", () => {
    const res = cronHealth([{ name: "warm-rankings-manuel", lastRunAt: new Date(0), ok: true, info: null }], now, {});
    expect(res[0].late).toBe(false);
  });
});
