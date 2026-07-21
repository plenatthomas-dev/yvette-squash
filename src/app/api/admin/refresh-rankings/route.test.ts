import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  admin: { userId: "adm", email: "admin@ex.com" } as null | { userId: string; email: string },
  featureRanking: true,
  refresh: { month: "2026-07-07", members: 3, matched: 2, cleared: 1 } as {
    month: string | null;
    members: number;
    matched: number;
    cleared: number;
  },
  refreshRankings: vi.fn(),
  recordCronRun: vi.fn(),
}));

vi.mock("@/lib/admin", () => ({
  requireAdmin: vi.fn(async () => h.admin),
}));
// Le flag est résolu à chaud côté serveur (env + override en base) : on mocke l'état effectif.
vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({
    tricount: false,
    emailLogin: false,
    biometry: false,
    directory: false,
    delegation: false,
    tournament: false,
    ranking: h.featureRanking,
  }),
}));
vi.mock("@/lib/squashnet/refresh", () => ({
  refreshRankings: h.refreshRankings,
}));
vi.mock("@/lib/cron-run", () => ({
  recordCronRun: h.recordCronRun,
}));

import { POST } from "./route";

const req = () => ({ cookies: { get: () => undefined } }) as unknown as NextRequest;

beforeEach(() => {
  h.admin = { userId: "adm", email: "admin@ex.com" };
  h.featureRanking = true;
  h.refresh = { month: "2026-07-07", members: 3, matched: 2, cleared: 1 };
  h.refreshRankings.mockReset().mockImplementation(async () => h.refresh);
  h.recordCronRun.mockReset().mockResolvedValue(undefined);
});

describe("POST /api/admin/refresh-rankings", () => {
  it("403 si non admin (et ne touche pas au classement)", async () => {
    h.admin = null;
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(h.refreshRankings).not.toHaveBeenCalled();
  });

  it("404 si le flag ranking est coupé", async () => {
    h.featureRanking = false;
    const res = await POST(req());
    expect(res.status).toBe(404);
    expect(h.refreshRankings).not.toHaveBeenCalled();
  });

  it("502 si la période de classement est introuvable (squashnet indispo)", async () => {
    h.refresh = { month: null, members: 0, matched: 0, cleared: 0 };
    const res = await POST(req());
    expect(res.status).toBe(502);
    // Pas de heartbeat trompeur si le rafraîchissement n'a rien pu faire.
    expect(h.recordCronRun).not.toHaveBeenCalled();
  });

  it("rafraîchit, renvoie le récap et met à jour le heartbeat (marqué manuel)", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      month: "2026-07-07",
      members: 3,
      matched: 2,
      cleared: 1,
    });
    expect(h.refreshRankings).toHaveBeenCalledOnce();
    expect(h.recordCronRun).toHaveBeenCalledWith(
      "warm-rankings",
      true,
      expect.stringContaining("manuel"),
    );
  });
});
