import { describe, it, expect, beforeEach, vi } from "vitest";

// LA FENÊTRE D'APRÈS-MATCH ET SA PORTE.
//
// Ce qui ne se voit pas à la relecture : la fenêtre se compte en heure MURALE du club. Le cron
// passe à heure ronde, et une heure UTC décalerait l'ouverture d'une à deux heures selon la
// saison — assez pour manquer le passage de 22 h le soir du match.

const h = vi.hoisted(() => ({
  cacheThrows: false,
  candidates: [] as Array<{ teamId: string; date: string }>,
  findManyArgs: [] as unknown[],
  fetchThrows: false,
  rows: [] as unknown[],
  updates: [] as Array<{ where: unknown; data: Record<string, unknown> }>,
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => () => {
    if (h.cacheThrows) throw new Error("cache indisponible");
    return fn();
  },
  revalidateTag: vi.fn(),
}));
vi.mock("./db", () => ({
  prisma: {
    interclub: {
      findMany: vi.fn(async (args: unknown) => {
        h.findManyArgs.push(args);
        return h.candidates;
      }),
    },
    interclubTeam: {
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        h.updates.push(args);
        return {};
      }),
    },
  },
}));
vi.mock("./squashnet/standings", () => ({
  fetchStandings: vi.fn(async () => {
    if (h.fetchThrows) throw new Error("502");
    return h.rows;
  }),
}));

import { standingsWindowOpen, teamsDueForStandings, refreshTeamStandings } from "./interclub-standings";

beforeEach(() => {
  h.cacheThrows = false;
  h.candidates = [];
  h.findManyArgs = [];
  h.fetchThrows = false;
  h.rows = [];
  h.updates = [];
});

describe("standingsWindowOpen — de 22 h le soir du match à la fin du 5e jour", () => {
  // Jeudi 15 octobre 2026, heure d'été : Paris = UTC+2.
  const D = "2026-10-15";

  it("reste fermée le soir du match avant 22 h", () => {
    expect(standingsWindowOpen(D, new Date("2026-10-15T19:59:00Z"))).toBe(false); // 21:59
  });

  it("s'ouvre à 22 h, heure de Paris", () => {
    expect(standingsWindowOpen(D, new Date("2026-10-15T20:00:00Z"))).toBe(true); // 22:00
  });

  it("s'ouvre aussi à 22 h en heure d'hiver, sans glisser d'une heure", () => {
    // Jeudi 12 novembre 2026 : Paris = UTC+1.
    expect(standingsWindowOpen("2026-11-12", new Date("2026-11-12T20:00:00Z"))).toBe(false); // 21:00
    expect(standingsWindowOpen("2026-11-12", new Date("2026-11-12T21:00:00Z"))).toBe(true); // 22:00
  });

  it("couvre la nuit, qui est déjà le lendemain", () => {
    expect(standingsWindowOpen(D, new Date("2026-10-16T00:00:00Z"))).toBe(true); // 02:00
  });

  it("couvre le dernier passage, à 22 h le cinquième jour", () => {
    expect(standingsWindowOpen(D, new Date("2026-10-20T20:00:00Z"))).toBe(true); // 20/10 22:00
    // Quelques secondes de retard du cron externe ne font pas sauter ce passage.
    expect(standingsWindowOpen(D, new Date("2026-10-20T20:00:30Z"))).toBe(true);
  });

  it("se referme le sixième jour", () => {
    expect(standingsWindowOpen(D, new Date("2026-10-21T00:00:00Z"))).toBe(false); // 21/10 02:00
  });

  it("n'ouvre rien AVANT le match", () => {
    expect(standingsWindowOpen(D, new Date("2026-10-14T20:00:00Z"))).toBe(false);
  });
});

describe("teamsDueForStandings — la porte", () => {
  const NOW = new Date("2026-10-16T08:00:00Z"); // vendredi 16/10, 10:00 à Paris

  it("rend chaque équipe en fenêtre une seule fois", async () => {
    h.candidates = [
      { teamId: "t1", date: "2026-10-15" }, // la veille : ouverte
      { teamId: "t1", date: "2026-10-13" }, // aussi ouverte, même équipe
      { teamId: "t2", date: "2026-10-22" }, // à venir : fermée
      { teamId: "t3", date: "2026-10-09" }, // sept jours : refermée
    ];
    expect(await teamsDueForStandings(NOW)).toEqual(["t1"]);
  });

  it("n'ouvre rien sur une date prévisionnelle sans score saisi", async () => {
    await teamsDueForStandings(NOW);
    const where = (h.findManyArgs[0] as { where: Record<string, unknown> }).where;
    expect(where.OR).toEqual([{ dateConfirmed: true }, { status: { not: "scheduled" } }]);
  });

  it("relit la base si le cache tombe, plutôt que de répondre « rien »", async () => {
    h.cacheThrows = true;
    h.candidates = [{ teamId: "t1", date: "2026-10-15" }];
    expect(await teamsDueForStandings(NOW)).toEqual(["t1"]);
  });
});

describe("refreshTeamStandings", () => {
  const team = { id: "t1", snEventId: "ev", snDrawId: "47760", snRoundId: "370138" };

  it("écrit le classement et sa date", async () => {
    h.rows = [{ rank: 1 }, { rank: 2 }];
    const r = await refreshTeamStandings(team);
    expect(r).toMatchObject({ ok: true, rows: 2 });
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].data.snStandingsJson).toBe(JSON.stringify(h.rows));
    expect(h.updates[0].data.snStandingsAt).toBeInstanceOf(Date);
  });

  it("n'écrase pas un tableau valide par du vide", async () => {
    h.rows = [];
    expect(await refreshTeamStandings(team)).toEqual({ ok: false, reason: "empty" });
    expect(h.updates).toHaveLength(0);
  });

  it("ne touche à rien quand squashnet ne répond pas", async () => {
    h.fetchThrows = true;
    expect(await refreshTeamStandings(team)).toEqual({ ok: false, reason: "unreachable" });
    expect(h.updates).toHaveLength(0);
  });
});
