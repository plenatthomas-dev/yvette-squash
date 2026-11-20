import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// La vérification squashnet à la demande : garde d'accès d'abord, rien hors fenêtre
// d'après-match, et un repos par équipe pour ne pas relancer la ligue à chaque dépliage.

const h = vi.hoisted(() => ({
  access: true,
  due: [] as string[],
  teams: [] as Array<Record<string, unknown>>,
  standings: vi.fn(),
  sheets: vi.fn(),
}));

vi.mock("@/lib/interclub-access", () => ({
  requireInterclubMember: vi.fn(async () =>
    h.access ? { ok: true, session: { userId: "u1" } } : { ok: false, response: new Response(null, { status: 401 }) },
  ),
}));
vi.mock("@/lib/db", () => ({
  prisma: { interclubTeam: { findMany: vi.fn(async () => h.teams) } },
}));
vi.mock("@/lib/interclub-standings", () => ({
  teamsDueForStandings: vi.fn(async () => h.due),
  refreshTeamStandings: (...a: unknown[]) => h.standings(...a),
}));
vi.mock("@/lib/interclub-sheets", () => ({
  refreshTeamSheets: (...a: unknown[]) => h.sheets(...a),
}));

import { POST } from "./route";

const req = {} as NextRequest;
const anchored = (id: string, at: Date | null = null) => ({
  id,
  snEventId: "e",
  snDrawId: "d",
  snRoundId: "r",
  snStandingsAt: at,
});

beforeEach(() => {
  h.access = true;
  h.due = [];
  h.teams = [];
  h.standings.mockReset().mockResolvedValue({ ok: true });
  h.sheets.mockReset().mockResolvedValue({ imported: 0, rebuilt: 0, corrected: 0 });
});

describe("POST /api/interclub/sync", () => {
  it("refuse un non-membre", async () => {
    h.access = false;
    expect((await POST(req)).status).toBe(401);
    expect(h.standings).not.toHaveBeenCalled();
  });

  it("hors fenêtre d'après-match : ne sort pas chez la ligue", async () => {
    const res = await POST(req);
    expect(await res.json()).toEqual({ checked: 0, refreshed: 0, imported: 0, rebuilt: 0, corrected: 0 });
    expect(h.sheets).not.toHaveBeenCalled();
  });

  it("relit classement et feuilles, et rapporte les rencontres complétées", async () => {
    h.due = ["t1"];
    h.teams = [anchored("t1")];
    h.sheets.mockResolvedValue({ imported: 1, rebuilt: 1, corrected: 2 });
    expect(await (await POST(req)).json()).toEqual({ checked: 1, refreshed: 1, imported: 1, rebuilt: 1, corrected: 2 });
  });

  it("repos : une équipe relue il y a moins de 5 minutes n'est pas relue", async () => {
    h.due = ["t2"];
    h.teams = [anchored("t2", new Date(Date.now() - 60_000))];
    expect(await (await POST(req)).json()).toEqual({ checked: 0, refreshed: 0, imported: 0, rebuilt: 0, corrected: 0 });
  });

  it("repos d'instance : deux appels rapprochés ne relisent qu'une fois", async () => {
    h.due = ["t3"];
    h.teams = [anchored("t3")];
    await POST(req);
    await POST(req);
    expect(h.sheets).toHaveBeenCalledTimes(1);
  });
});
