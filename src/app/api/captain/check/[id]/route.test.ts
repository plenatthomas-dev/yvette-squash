import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  access: { ok: true } as { ok: boolean; status?: number },
  fixture: null as null | Record<string, unknown>,
  month: "2026-09-07" as string | null,
  rows: [] as unknown[],
  searchThrows: false,
  findUnique: vi.fn(),
  upsert: vi.fn(),
  searchRanking: vi.fn(),
  getLatestMonth: vi.fn(),
}));

vi.mock("@/lib/captain-access", () => ({
  requireCaptainOf: vi.fn(async () =>
    h.access.ok
      ? { ok: true, session: { userId: "u1" }, teamIds: ["t1"], isAdmin: false }
      : {
          ok: false,
          response: new Response(null, { status: h.access.status ?? 403 }) as unknown,
        },
  ),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    interclub: { findUnique: (...a: unknown[]) => h.findUnique(...a) },
    interclubOfficial: { upsert: (...a: unknown[]) => h.upsert(...a) },
  },
}));
vi.mock("@/lib/squashnet/client", () => ({
  getLatestMonth: (...a: unknown[]) => h.getLatestMonth(...a),
  searchRanking: (...a: unknown[]) => h.searchRanking(...a),
}));

import { GET, POST } from "./route";

const req = () => ({ cookies: { get: () => undefined } }) as unknown as NextRequest;
const ctx = (id = "f1") => ({ params: Promise.resolve({ id }) });

/** Une ligne de classement du club de l'Yvette. */
const ligne = (name: string, club = "Squash de l yvette") => ({
  name,
  clt: "5A",
  club,
  licence: "0124215",
  ligue: "IDF",
  cat: "Senior",
  gender: "male",
  rang: "42",
  rangM: "30",
  mean: "1 000",
});

/** Une rencontre à un simple, gagnée 3-0, telle que Prisma la rend. */
function rencontre(over: Record<string, unknown> = {}) {
  return {
    teamId: "t1",
    opponent: "Squash Club de Rennes",
    matchCount: 1,
    bestOf: 5,
    matches: [
      {
        order: 1,
        homeDisplayName: "Jean Dupont",
        awayName: "Paul Martin",
        games: [
          { pointsHome: 11, pointsAway: 5 },
          { pointsHome: 11, pointsAway: 6 },
          { pointsHome: 11, pointsAway: 7 },
        ],
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  h.access = { ok: true };
  h.fixture = rencontre();
  h.month = "2026-09-07";
  h.searchThrows = false;
  h.findUnique.mockReset().mockImplementation(async () => h.fixture);
  h.upsert.mockReset().mockResolvedValue({});
  h.getLatestMonth.mockReset().mockImplementation(async () => h.month);
  h.searchRanking.mockReset().mockImplementation(async (q: string) => {
    if (h.searchThrows) throw new Error("squashnet muet");
    return q === "Dupont"
      ? [ligne("DUPONT JEAN")]
      : [ligne("MARTIN PAUL", "Squash Club de Rennes")];
  });
});

describe("POST /api/captain/check/{id}", () => {
  it("404 sur une rencontre inconnue, sans rien révéler de plus", async () => {
    h.fixture = null;
    expect((await POST(req(), ctx())).status).toBe(404);
  });

  // L'accès se contrôle sur l'ÉQUIPE de la rencontre : c'est ce qui empêche le capitaine de
  // l'Équipe 1 d'agir sur une rencontre de l'Équipe 2.
  it("relaie le refus du contrôle d'accès, et ne touche à rien", async () => {
    h.access = { ok: false, status: 403 };
    expect((await POST(req(), ctx())).status).toBe(403);
    expect(h.searchRanking).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("vérifie les DEUX camps, chacun dans SON club", async () => {
    await POST(req(), ctx());
    const { report } = await (await POST(req(), ctx())).json();
    const nous = report.players.find((p: { side: string }) => p.side === "home");
    const eux = report.players.find((p: { side: string }) => p.side === "away");
    expect(nous).toMatchObject({ verdict: "found", fedName: "DUPONT JEAN" });
    // L'adversaire est cherché dans le club adverse : trouvé chez nous, il serait « other-club ».
    expect(eux).toMatchObject({ verdict: "found", fedName: "MARTIN PAUL" });
  });

  // Seize appels au lieu de huit, pour une valeur identique huit fois de suite : c'est ce que
  // ferait `searchRanking(nom)` sans mois, qui va chercher la période lui-même.
  it("ne lit la période qu'UNE fois, et la passe à chaque recherche", async () => {
    await POST(req(), ctx());
    expect(h.getLatestMonth).toHaveBeenCalledOnce();
    for (const call of h.searchRanking.mock.calls) {
      expect(call[1]).toEqual({ month: "2026-09-07" });
    }
  });

  it("mutualise UNE recherche entre deux joueurs du même nom de famille", async () => {
    h.fixture = rencontre({
      matchCount: 2,
      matches: [
        ...rencontre().matches,
        {
          order: 2,
          homeDisplayName: "Marie Dupont", // même nom de famille que le simple n°1
          awayName: "Luc Martin",
          games: [
            { pointsHome: 11, pointsAway: 5 },
            { pointsHome: 11, pointsAway: 6 },
            { pointsHome: 11, pointsAway: 7 },
          ],
        },
      ],
    });
    await POST(req(), ctx());
    // Quatre joueurs, mais seulement deux termes distincts (« Dupont », « Martin »).
    expect(h.searchRanking).toHaveBeenCalledTimes(2);
  });

  it("squashnet sans période → 502, et AUCUN rapport écrit", async () => {
    h.month = null;
    expect((await POST(req(), ctx())).status).toBe(502);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  // « squashnet n'a pas répondu » et « ce joueur n'existe pas » appellent deux réactions
  // opposées : la seconde envoie corriger une orthographe qui peut être parfaitement juste.
  it("un silence de squashnet ne se dit pas « introuvable »", async () => {
    h.searchThrows = true;
    const { report } = await (await POST(req(), ctx())).json();
    for (const p of report.players) {
      expect(p.verdict).toBe("unknown");
      expect(p.hint).toMatch(/n'a pas répondu/);
      expect(p.hint).not.toMatch(/orthographe/i);
    }
  });

  it("range le rapport sous la rencontre, en corrigeant au lieu d'empiler", async () => {
    await POST(req(), ctx());
    const args = h.upsert.mock.calls[0][0] as { where: unknown; create: { interclubId: string } };
    expect(args.where).toEqual({ interclubId: "f1" });
    expect(args.create.interclubId).toBe("f1");
  });

  // LE DÉTAIL POINT PAR POINT remonte tel quel : c'est ce que le capitaine recopie chez la ligue.
  it("rend les points jeu par jeu, pas seulement le compte des jeux", async () => {
    const { report } = await (await POST(req(), ctx())).json();
    expect(report.scores[0].games).toEqual([
      { home: 11, away: 5 },
      { home: 11, away: 6 },
      { home: 11, away: 7 },
    ]);
  });

  // L'ordre d'en face se déduit des joueurs déjà rapprochés : aucun appel réseau de plus.
  it("vérifie l'ordre des simples adverses sans une requête supplémentaire", async () => {
    h.fixture = rencontre({
      matchCount: 2,
      matches: [
        ...rencontre().matches,
        {
          order: 2,
          homeDisplayName: "Marie Dupont",
          awayName: "Luc Bernard",
          games: [
            { pointsHome: 11, pointsAway: 5 },
            { pointsHome: 11, pointsAway: 6 },
            { pointsHome: 11, pointsAway: 7 },
          ],
        },
      ],
    });
    // Bernard (simple 2) est MIEUX classé que Martin (simple 1) : l'ordre est rompu.
    h.searchRanking.mockImplementation(async (q: string) => {
      if (q === "Dupont") return [ligne("DUPONT JEAN")];
      if (q === "Martin") return [{ ...ligne("MARTIN PAUL", "Squash Club de Rennes"), clt: "5A", rangM: "900" }];
      return [{ ...ligne("BERNARD LUC", "Squash Club de Rennes"), clt: "4A", rangM: "100" }];
    });
    const avant = h.searchRanking.mock.calls.length;
    const { report } = await (await POST(req(), ctx())).json();
    expect(report.awayOrder.status).toBe("violation");
    // Trois termes distincts (Dupont, Martin, Bernard) — et rien de plus pour l'ordre.
    expect(h.searchRanking.mock.calls.length - avant).toBe(3);
  });

  it("contrôle les scores sans passer par le réseau, avec le bestOf de la RENCONTRE", async () => {
    // Un simple à deux jeux gagnés n'est pas terminé en bo5 : c'est un problème, et il se dit.
    h.fixture = rencontre({
      matches: [
        {
          order: 1,
          homeDisplayName: "Jean Dupont",
          awayName: "Paul Martin",
          games: [
            { pointsHome: 11, pointsAway: 5 },
            { pointsHome: 11, pointsAway: 6 },
          ],
        },
      ],
    });
    const { report } = await (await POST(req(), ctx())).json();
    expect(report.scores[0]).toMatchObject({ ok: false, winner: null });
    expect(report.tie.ok).toBe(false);
  });
});

describe("GET /api/captain/check/{id}", () => {
  it("relit le dernier rapport SANS toucher à squashnet", async () => {
    const stocke = {
      checkedAt: "2026-09-10T10:00:00.000Z",
      players: [],
      scores: [],
      tie: { ok: true, home: 2, away: 2, undecided: 0, problem: null },
      awayOrder: { status: "ok", problem: null },
    };
    h.fixture = { teamId: "t1", official: { checkJson: JSON.stringify(stocke) } };
    const { report } = await (await GET(req(), ctx())).json();
    expect(report.tie.home).toBe(2);
    expect(h.searchRanking).not.toHaveBeenCalled();
    expect(h.getLatestMonth).not.toHaveBeenCalled();
  });

  it("jamais vérifiée → `null`, pas une erreur", async () => {
    h.fixture = { teamId: "t1", official: null };
    const { report } = await (await GET(req(), ctx())).json();
    expect(report).toBeNull();
  });

  // Un rapport d'un format antérieur passe `JSON.parse` et lèverait au rendu, où il n'y a pas
  // d'error boundary : il se dit « pas de rapport », ce qui se rattrape en revérifiant.
  it("rapport d'un format périmé → `null` plutôt qu'un objet qui lèvera à l'affichage", async () => {
    h.fixture = { teamId: "t1", official: { checkJson: '{"ancien":"format"}' } };
    const { report } = await (await GET(req(), ctx())).json();
    expect(report).toBeNull();
  });

  it("relaie le refus du contrôle d'accès", async () => {
    h.access = { ok: false, status: 403 };
    expect((await GET(req(), ctx())).status).toBe(403);
  });
});
