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
  refreshOwnTieIds: vi.fn(),
  readTieSheet: vi.fn(),
  teamCode: vi.fn(),
}));

vi.mock("@/lib/captain-access", () => ({
  // La PORTE : flag → session → rôle, sans identifiant d'équipe. La route l'appelle AVANT de
  // lire la rencontre, pour qu'une requête anonyme ne déclenche aucune lecture en base et que
  // l'écart 401/404 ne révèle pas qu'une rencontre existe à cette adresse.
  requireCaptain: vi.fn(async () =>
    h.access.ok
      ? { ok: true, session: { userId: "u1" }, teamIds: ["t1"], isAdmin: false }
      : {
          ok: false,
          response: new Response(null, { status: h.access.status ?? 403 }) as unknown,
        },
  ),
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
// LA LECTURE DE LA FEUILLE FÉDÉRALE est simulée ici, mais la CONFRONTATION ne l'est pas : c'est
// le vrai `captain-official.ts` qui tourne. Ce qu'on vérifie est donc bien ce que la route
// conclut, et non ce qu'un double aurait bien voulu lui faire dire.
vi.mock("@/lib/interclub-tie-db", () => ({
  refreshOwnTieIds: (...a: unknown[]) => h.refreshOwnTieIds(...a),
  readTieSheet: (...a: unknown[]) => h.readTieSheet(...a),
  teamCode: (...a: unknown[]) => h.teamCode(...a),
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
    snOpponentTeamId: null,
    snTieId: null,
    team: { snTeamId: null },
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
  h.refreshOwnTieIds.mockReset().mockResolvedValue({ status: "noTeamId", posed: 0, missing: 0 });
  h.readTieSheet.mockReset().mockResolvedValue({ sheet: null, error: "failed" });
  h.teamCode.mockReset().mockResolvedValue(null);
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
    // Les QUATRE joueurs doivent être rapprochés, sans quoi le second terme de `queryTerms`
    // entrerait en jeu et ce test compterait des requêtes qui ne le regardent pas.
    h.searchRanking.mockImplementation(async (q: string) =>
      q === "Dupont"
        ? [ligne("DUPONT JEAN"), ligne("DUPONT MARIE")]
        : [ligne("MARTIN PAUL", "Chaville"), ligne("MARTIN LUC", "Chaville")],
    );
    await POST(req(), ctx());
    // Quatre joueurs, mais seulement deux termes distincts (« Dupont », « Martin »).
    expect(h.searchRanking).toHaveBeenCalledTimes(2);
  });

  // ⚠️ LE SECOND TERME NE PART QUE SUR UN VRAI ÉCHEC. `queryTerms` en propose deux — le dernier
  // mot puis le premier —, parce qu'on ne sait pas de quel côté est le nom de famille. Les
  // essayer tous les deux systématiquement doublerait le trafic chez un site associatif.
  it("n'essaie le SECOND terme que si le premier n'a rapproché personne", async () => {
    h.searchRanking.mockImplementation(async (q: string) =>
      q === "Dupont" ? [ligne("DUPONT JEAN")] : [ligne("MARTIN PAUL", "Chaville")],
    );
    await POST(req(), ctx());
    // Deux joueurs trouvés du premier coup : « Jean » et « Paul » ne sont jamais demandés.
    expect(h.searchRanking).toHaveBeenCalledTimes(2);
    expect(h.searchRanking.mock.calls.map((c: unknown[]) => c[0])).toEqual(["Dupont", "Martin"]);
  });

  it("rattrape un nom écrit dans l'ORDRE FÉDÉRAL par son second terme", async () => {
    // « DUPONT JEAN » est la forme que le menu propose depuis que le roster l'alimente. Le
    // dernier mot est alors le PRÉNOM : mesuré chez eux, « XAVIER » rend 62 résultats paginés
    // là où « DETRY » en rend 1. Sans second terme, le verdict serait « introuvable » sur un
    // nom parfaitement juste.
    h.fixture = rencontre({ matches: [{ ...rencontre().matches[0], homeDisplayName: "DUPONT JEAN" }] });
    h.searchRanking.mockImplementation(async (q: string) =>
      q === "DUPONT" ? [ligne("DUPONT JEAN")] : [],
    );
    const { report } = await (await POST(req(), ctx())).json();
    const nous = report.players.find((p: { side: string }) => p.side === "home");
    expect(nous.verdict).toBe("found");
    expect(h.searchRanking.mock.calls.map((c: unknown[]) => c[0])).toContain("JEAN");
    expect(h.searchRanking.mock.calls.map((c: unknown[]) => c[0])).toContain("DUPONT");
  });

  // LE BOGUE DES ÉQUIPES NUMÉROTÉES. « Chaville 4 » est une ÉQUIPE ; le classement range ses
  // joueurs sous le CLUB « Chaville ». Sans la coupe, aucun adversaire d'une équipe numérotée
  // n'était jamais trouvé — et le remède affiché envoyait corriger une orthographe correcte.
  it("cherche l'adversaire sous son CLUB, pas sous le nom numéroté de son équipe", async () => {
    h.fixture = rencontre({ opponent: "Chaville 4" });
    h.searchRanking.mockImplementation(async (q: string) =>
      q === "Dupont" ? [ligne("DUPONT JEAN")] : [ligne("MARTIN PAUL", "Chaville")],
    );
    const { report } = await (await POST(req(), ctx())).json();
    const eux = report.players.find((p: { side: string }) => p.side === "away");
    expect(eux).toMatchObject({ verdict: "found", fedName: "MARTIN PAUL" });
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
      // Les DEUX Dupont sont rapprochés : sans cela, « Marie » partirait en second terme et ce
      // test compterait une requête qui ne concerne pas l'ordre des simples.
      if (q === "Dupont") return [ligne("DUPONT JEAN"), ligne("DUPONT MARIE")];
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

// ============================================================================
//  LA FEUILLE OFFICIELLE, LUE CHEZ LA LIGUE.
//
//  C'est la seule partie du rapport qui ne parle pas de nous : elle confronte
//  notre relevé au document qui fera le classement. Ce qui compte ici n'est pas
//  qu'elle réussisse — c'est qu'elle ne puisse JAMAIS faire échouer le reste.
// ============================================================================

/** La feuille fédérale d'une rencontre à un simple, gagnée 1-0 par le côté A. */
const feuille = (over: Record<string, unknown> = {}) => ({
  snTieId: "999",
  codeA: "YVET1",
  codeB: "RENN1",
  division: "Hommes 4",
  group: "Poule A",
  round: "J1",
  venue: "Yvette",
  date: "2026-09-04",
  time: "20:00",
  lines: [
    {
      label: "Homme 1",
      a: { name: "DUPONT JEAN", regiid: "1", clt: "5A", rang: 42, rangM: 30 },
      b: { name: "MARTIN PAUL", regiid: "2", clt: "4C", rang: 20, rangM: 15 },
      score: "11-5 11-6 11-7",
      winner: "A",
      gamesA: 3,
      gamesB: 0,
      pointsA: 33,
      pointsB: 18,
    },
  ],
  totals: { matchesA: 1, matchesB: 0, gamesA: 3, gamesB: 0, pointsA: 33, pointsB: 18 },
  ...over,
});

describe("POST /api/captain/check/{id} — la feuille officielle", () => {
  it("dit « pas d'identifiant fédéral » sans rien aller chercher", async () => {
    // Une rencontre saisie à la main n'a pas de feuille chez la ligue. C'est un fait, pas une
    // panne — et surtout, ça ne justifie aucune requête.
    const { report } = await (await POST(req(), ctx())).json();
    expect(report.official.status).toBe("absent");
    expect(h.readTieSheet).not.toHaveBeenCalled();
  });

  it("va chercher l'identifiant sur la fiche d'équipe quand il manque", async () => {
    // Le `tieid` n'est PAS dans le calendrier : il n'existe que sur la fiche de notre équipe.
    // Une rencontre importée avant cette lecture n'en porte donc pas, et doit pouvoir le
    // rattraper toute seule.
    h.fixture = rencontre({ snTieId: null });
    h.refreshOwnTieIds.mockImplementation(async () => {
      // La passe pose l'identifiant ; la route le relit ensuite.
      h.findUnique.mockImplementation(async () => ({ ...rencontre(), snTieId: "999" }));
      return { status: "posed", posed: 1, missing: 0 };
    });
    h.readTieSheet.mockResolvedValue({ sheet: feuille(), error: null });
    h.teamCode.mockResolvedValue("YVET1");

    const { report } = await (await POST(req(), ctx())).json();
    expect(h.refreshOwnTieIds).toHaveBeenCalledWith("t1");
    expect(report.official).toMatchObject({ status: "match", home: 1, away: 0 });
  });

  it("confronte notre relevé à la feuille, et annonce la concordance", async () => {
    h.fixture = rencontre({ snTieId: "999", team: { snTeamId: "42" } });
    h.readTieSheet.mockResolvedValue({ sheet: feuille(), error: null });
    h.teamCode.mockResolvedValue("YVET1");

    const { report } = await (await POST(req(), ctx())).json();
    expect(report.official).toMatchObject({
      status: "match",
      home: 1,
      away: 0,
      oursHome: 1,
      oursAway: 0,
      side: "A",
    });
    expect(report.official.problems).toEqual([]);
    // La feuille est atteinte par l'identifiant de LA RENCONTRE, pas par autre chose.
    expect(h.readTieSheet).toHaveBeenCalledWith("999");
  });

  it("relève l'écart quand la ligue publie autre chose", async () => {
    h.fixture = rencontre({ snTieId: "999" });
    h.readTieSheet.mockResolvedValue({
      sheet: feuille({
        lines: [{ ...feuille().lines[0], gamesA: 3, gamesB: 2, winner: "A" }],
      }),
      error: null,
    });
    h.teamCode.mockResolvedValue("YVET1");

    const { report } = await (await POST(req(), ctx())).json();
    expect(report.official.status).toBe("diverges");
    expect(report.official.problems).toContain(
      "Simple n° 1 : la ligue publie 3-2 en jeux, notre relevé dit 3-0.",
    );
  });

  it("⚠️ NE FAIT PAS ÉCHOUER la vérification quand la ligue est muette", async () => {
    // Le reste du rapport — nos scores, nos joueurs, l'ordre des simples — ne dépend pas de la
    // ligue. En priver un capitaine parce qu'une lecture d'appoint a échoué serait un mauvais
    // échange, et il n'aurait aucun moyen de le contourner.
    h.fixture = rencontre({ snTieId: "999" });
    h.readTieSheet.mockResolvedValue({ sheet: null, error: "failed" });

    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    const { report } = await res.json();
    expect(report.official.status).toBe("unread");
    expect(report.scores[0]).toMatchObject({ ok: true, gamesHome: 3 });
    expect(report.tie).toMatchObject({ home: 1, away: 0 });
  });

  it("⚠️ ne survit pas non plus à un échec de la pose d'identifiant", async () => {
    // `refreshOwnTieIds` touche la base et le réseau : elle peut jeter. La vérification, elle,
    // doit aboutir sur ce qu'on a.
    h.refreshOwnTieIds.mockRejectedValue(new Error("Neon indisponible"));
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).report.official.status).toBe("absent");
  });

  it("⚠️ NE COMPARE RIEN quand notre côté ne se reconnaît pas", async () => {
    // La ligue nomme les deux camps « A » et « B » sans dire lequel reçoit. Aucun sigle connu,
    // aucun de nos noms sur la feuille : deviner aurait une chance sur deux d'inverser le score.
    h.fixture = rencontre({ snTieId: "999" });
    h.readTieSheet.mockResolvedValue({
      sheet: feuille({
        codeA: "AAAA",
        codeB: "BBBB",
        lines: [
          {
            ...feuille().lines[0],
            a: { name: "INCONNU UN", regiid: "1", clt: "5A", rang: 1, rangM: 1 },
            b: { name: "INCONNU DEUX", regiid: "2", clt: "5A", rang: 2, rangM: 2 },
          },
        ],
      }),
      error: null,
    });

    const { report } = await (await POST(req(), ctx())).json();
    expect(report.official.status).toBe("unread");
    expect(report.official.home).toBeNull();
    expect(report.official.problems[0]).toMatch(/impossible de reconnaître notre équipe/);
  });
});
