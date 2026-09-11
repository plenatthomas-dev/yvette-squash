import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  access: { ok: true, teamIds: ["t1"], isAdmin: false } as {
    ok: boolean;
    status?: number;
    teamIds?: string[];
    isAdmin?: boolean;
  },
  teams: [] as { id: string; name: string; snTeamId: string | null }[],
  fixtures: [] as Record<string, unknown>[],
  teamFindMany: vi.fn(),
  fixtureFindMany: vi.fn(),
  rosterFindMany: vi.fn(),
}));

vi.mock("@/lib/captain-access", () => ({
  requireCaptain: vi.fn(async () =>
    h.access.ok
      ? {
          ok: true,
          session: { userId: "u1" },
          teamIds: h.access.teamIds ?? [],
          isAdmin: h.access.isAdmin ?? false,
        }
      : { ok: false, response: new Response(null, { status: h.access.status ?? 403 }) },
  ),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    interclubTeam: { findMany: (...a: unknown[]) => h.teamFindMany(...a) },
    interclub: { findMany: (...a: unknown[]) => h.fixtureFindMany(...a) },
    squashnetTeamRoster: { findMany: (...a: unknown[]) => h.rosterFindMany(...a) },
  },
}));

import { GET } from "./route";

const req = () => ({ cookies: { get: () => undefined } }) as unknown as NextRequest;

const rapportOk = JSON.stringify({
  checkedAt: "2026-09-10T10:00:00.000Z",
  players: [],
  scores: [],
  tie: { ok: true, home: 2, away: 2, undecided: 0, problem: null },
  awayOrder: { status: "ok", problem: null },
});

function fixture(over: Record<string, unknown> = {}) {
  return {
    id: "f1",
    date: "2026-09-04",
    time: "20:00",
    round: "J1",
    opponent: "Squash Club de Rennes",
    home: true,
    status: "done",
    teamId: "t1",
    matchCount: 4,
    official: null,
    ...over,
  };
}

beforeEach(() => {
  h.access = { ok: true, teamIds: ["t1"], isAdmin: false };
  h.teams = [{ id: "t1", name: "Équipe 1", snTeamId: "42" }];
  h.fixtures = [fixture()];
  h.teamFindMany.mockReset().mockImplementation(async () => h.teams);
  h.fixtureFindMany.mockReset().mockImplementation(async () => h.fixtures);
  h.rosterFindMany.mockReset().mockImplementation(async () => []);
});

describe("GET /api/captain", () => {
  it("relaie le refus du contrôle d'accès", async () => {
    h.access = { ok: false, status: 403 };
    expect((await GET(req())).status).toBe(403);
    expect(h.fixtureFindMany).not.toHaveBeenCalled();
  });

  // LA garde de portée : un capitaine n'a rien à faire sur les rencontres d'en face, et son
  // accès fédéral ne les couvre pas davantage.
  it("ne lit QUE les équipes du capitaine", async () => {
    await GET(req());
    expect(h.teamFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["t1"] } } }),
    );
    expect(h.fixtureFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teamId: { in: ["t1"] } } }),
    );
  });

  // Un admin qui n'est capitaine de rien a `teamIds` vide : sans ce cas, il verrait une page
  // vide là où il est précisément là pour dépanner.
  it("un admin voit toutes les équipes, même sans être capitaine", async () => {
    h.access = { ok: true, teamIds: [], isAdmin: true };
    await GET(req());
    expect(h.teamFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });

  it("rend les rencontres les plus RÉCENTES d'abord — cet ordre EST le tri de l'écran", async () => {
    await GET(req());
    expect(h.fixtureFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { date: "desc" } }),
    );
  });

  it("jamais vérifiée → `problems` à null, pas à zéro", async () => {
    const { fixtures } = await (await GET(req())).json();
    // `0` voudrait dire « vérifiée, rien à signaler » — l'inverse de la vérité.
    expect(fixtures[0]).toMatchObject({ checkedAt: null, problems: null });
  });

  it("vérifiée sans problème → 0, avec sa date", async () => {
    h.fixtures = [
      fixture({ official: { checkedAt: new Date("2026-09-10T10:00:00Z"), checkJson: rapportOk } }),
    ];
    const { fixtures } = await (await GET(req())).json();
    expect(fixtures[0].problems).toBe(0);
    expect(fixtures[0].checkedAt).toBe("2026-09-10T10:00:00.000Z");
  });

  it("compte les points à régler du dernier rapport", async () => {
    const avecSoucis = JSON.stringify({
      checkedAt: "2026-09-10T10:00:00.000Z",
      players: [{ order: 1, side: "home", name: "X", verdict: "unknown", hint: "…" }],
      scores: [{ order: 1, ok: false, problem: "…", gamesHome: 1, gamesAway: 0, winner: null }],
      tie: { ok: false, home: 1, away: 0, undecided: 1, problem: "…" },
      awayOrder: { status: "ok", problem: null },
    });
    h.fixtures = [fixture({ official: { checkedAt: new Date(), checkJson: avecSoucis } })];
    const { fixtures } = await (await GET(req())).json();
    expect(fixtures[0].problems).toBe(3); // 1 joueur + 1 score + 1 rencontre
  });

  // Un rapport d'un format qu'on ne sait plus lire se rattrape comme une absence de rapport :
  // en revérifiant. Les deux se disent donc pareil, plutôt que de lever à l'affichage.
  it("rapport périmé → `problems` à null, comme une rencontre jamais vérifiée", async () => {
    h.fixtures = [
      fixture({ official: { checkedAt: new Date(), checkJson: '{"ancien":"format"}' } }),
    ];
    const { fixtures } = await (await GET(req())).json();
    expect(fixtures[0].problems).toBeNull();
  });

  // La liste n'affiche que des pastilles : servir quarante rapports complets pour quarante
  // pastilles ferait payer la page entière pour ce qu'on ouvre une fois.
  it("ne renvoie JAMAIS le rapport complet dans la liste", async () => {
    h.fixtures = [fixture({ official: { checkedAt: new Date(), checkJson: rapportOk } })];
    const { fixtures } = await (await GET(req())).json();
    expect(fixtures[0]).not.toHaveProperty("checkJson");
    expect(fixtures[0]).not.toHaveProperty("official");
  });

  it("nomme l'équipe de chaque rencontre", async () => {
    const { fixtures, teams } = await (await GET(req())).json();
    // L'identifiant fédéral ne sort pas : il sert à retrouver la fiche, l'écran n'en fait rien.
    expect(teams).toEqual([{ id: "t1", name: "Équipe 1" }]);
    expect(fixtures[0].teamName).toBe("Équipe 1");
  });

  it("donne le nom que la LIGUE emploie pour notre équipe", async () => {
    // « Yvette 1 », le même vocabulaire que « Verrieres 3 » en face — donc rien à traduire
    // quand on lit les deux camps d'un simple l'un sous l'autre. Et il distingue DEUX équipes,
    // ce que « nous » ne faisait pas.
    h.rosterFindMany.mockImplementation(async () => [{ snTeamId: "42", name: "Yvette 1" }]);
    const { fixtures } = await (await GET(req())).json();
    expect(fixtures[0].teamFedName).toBe("Yvette 1");
  });

  it("retombe sur notre nom interne tant que la fiche fédérale n'est pas connue", async () => {
    // La fiche arrive avec la première vérification (elle est lue pour son `tieid`). Avant, il
    // n'y a rien — et « Équipe 1 » vaut mieux qu'une case vide.
    const { fixtures } = await (await GET(req())).json();
    expect(fixtures[0].teamFedName).toBeNull();
    expect(fixtures[0].teamName).toBe("Équipe 1");
  });

  it("n'interroge pas la base pour rien quand aucune équipe n'est ancrée", async () => {
    h.teams = [{ id: "t1", name: "Équipe 1", snTeamId: null }];
    await GET(req());
    expect(h.rosterFindMany).not.toHaveBeenCalled();
  });
});
