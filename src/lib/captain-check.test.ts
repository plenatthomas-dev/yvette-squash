import { describe, it, expect } from "vitest";
import {
  checkPlayer,
  checkScore,
  checkTie,
  countProblems,
  estRapportValide,
  identityOf,
  lireRapport,
  queryOf,
  type CheckReport,
  type MatchInput,
} from "./captain-check";
import { UNSET_PLAYER } from "./interclub";
import { YVETTE_CLUB } from "./squashnet/match";
import type { RankingRow } from "./squashnet/client";

function row(name: string, over: Partial<RankingRow> = {}): RankingRow {
  return {
    name,
    clt: "5A",
    club: YVETTE_CLUB,
    licence: "0124215",
    ligue: "IDF",
    cat: "Senior",
    gender: "male",
    rang: "42",
    rangM: "30",
    mean: "1 000",
    ...over,
  };
}

const simple = (over: Partial<MatchInput> = {}): MatchInput => ({
  order: 1,
  homeDisplayName: "Jean Dupont",
  awayName: "Paul Martin",
  bestOf: 5,
  games: [
    { home: 11, away: 5 },
    { home: 11, away: 9 },
    { home: 11, away: 7 },
  ],
  ...over,
});

describe("queryOf / identityOf", () => {
  // Ces deux-là doivent conclure comme `defaultIdentity` de `squashnet/refresh.ts` : si la
  // vérification annonçait « trouvé » là où le rafraîchissement mensuel échoue, le capitaine ne
  // saurait plus lequel croire.
  it("cherche sur le dernier mot, et compare l'identité entière", () => {
    expect(queryOf("Jean Dupont")).toBe("Dupont");
    expect(queryOf("  Jean-Luc  De La Tour  ")).toBe("Tour");
    expect(identityOf(" Jean Dupont ")).toEqual({ givenName: "", familyName: "Jean Dupont" });
  });
});

describe("checkPlayer", () => {
  it("une seule ligne du club attendu → trouvé, avec le nom FÉDÉRAL à recopier", () => {
    const p = checkPlayer(1, "home", "Jean Dupont", [row("DUPONT JEAN")], YVETTE_CLUB);
    expect(p).toMatchObject({
      verdict: "found",
      fedName: "DUPONT JEAN",
      clt: "5A",
      licence: "0124215",
      hint: null,
    });
  });

  // Le club attendu n'est PAS le nôtre pour un joueur d'en face : c'est le paramètre que
  // `matchRanking`/`classifyRanking` portait déjà dans sa signature sans que personne s'en serve.
  it("un adversaire se cherche dans SON club, pas dans le nôtre", () => {
    const rows = [row("MARTIN PAUL", { club: "Squash Club de Rennes" })];
    expect(checkPlayer(1, "away", "Paul Martin", rows, "Squash Club de Rennes").verdict).toBe(
      "found",
    );
    // Le même joueur, cherché chez nous, n'y est pas — et ce n'est pas « introuvable ».
    expect(checkPlayer(1, "away", "Paul Martin", rows, YVETTE_CLUB).verdict).toBe("other-club");
  });

  it("retrouvé ailleurs → dit OÙ, parce que c'est ce qui permet de comprendre", () => {
    const rows = [row("DUPONT JEAN", { club: "Squash Club de Rennes" })];
    const p = checkPlayer(1, "home", "Jean Dupont", rows, YVETTE_CLUB);
    expect(p.verdict).toBe("other-club");
    expect(p.club).toBe("Squash Club de Rennes");
    expect(p.hint).toContain("Squash Club de Rennes");
  });

  it("introuvable → le remède nomme l'orthographe en PREMIER", () => {
    const p = checkPlayer(1, "home", "Jean Dupont", [row("MARTIN PIERRE")], YVETTE_CLUB);
    expect(p.verdict).toBe("unknown");
    // La panne la plus fréquente, et celle que le dépôt documente déjà (squashnetGivenName).
    expect(p.hint).toMatch(/orthographe/i);
  });

  it("homonymes ambigus dans le club → on n'affirme rien", () => {
    const rows = [row("DUPONT JEAN"), row("DUPONT JEAN", { licence: "0999999" })];
    expect(checkPlayer(1, "home", "Jean Dupont", rows, YVETTE_CLUB).verdict).toBe("unknown");
  });

  // Un simple « à désigner » n'a rien à chercher : le classer « introuvable » avec un remède
  // d'orthographe noierait les vrais problèmes sous des lignes que personne ne peut résoudre.
  it("un joueur non désigné a son propre message, pas celui d'un nom mal orthographié", () => {
    for (const nom of [UNSET_PLAYER, "", "   "]) {
      const p = checkPlayer(1, "home", nom, [row("DUPONT JEAN")], YVETTE_CLUB);
      expect(p.verdict).toBe("unknown");
      expect(p.hint).toMatch(/Aucun joueur n'est désigné/);
      expect(p.hint).not.toMatch(/orthographe/i);
    }
  });
});

describe("checkScore", () => {
  it("un score complet et cohérent passe, avec son vainqueur", () => {
    expect(checkScore(simple())).toMatchObject({
      ok: true,
      problem: null,
      gamesHome: 3,
      gamesAway: 0,
      winner: "home",
    });
  });

  // Le jugement vient de `interclub.ts` : la vérification et la saisie doivent dire LA MÊME
  // CHOSE du même score, sans quoi le capitaine arbitre entre deux messages contradictoires.
  it("reprend mot pour mot le diagnostic de la saisie", () => {
    // 13-9 : au-delà de 11, seul un écart de 2 conclut un jeu. Le message est celui de
    // `describeSequenceProblem`, mot pour mot.
    const impossible = checkScore(simple({ games: [{ home: 13, away: 9 }] }));
    expect(impossible.ok).toBe(false);
    expect(impossible.problem).toMatch(/Jeu 1 : score impossible/);
    // 11-10 n'est PAS impossible : c'est un jeu qui n'est pas fini (il faut 2 points d'écart).
    // Les deux se distinguent, et l'écran ne doit pas envoyer corriger un score correct.
    const encours = checkScore(simple({ games: [{ home: 11, away: 10 }] }));
    expect(encours.problem).toMatch(/Jeu 1 : pas encore terminé/);
  });

  it("un score valide mais INACHEVÉ est signalé, pas passé sous silence", () => {
    const s = checkScore(simple({ games: [{ home: 11, away: 5 }, { home: 11, away: 9 }] }));
    expect(s).toMatchObject({ ok: false, winner: null });
    expect(s.problem).toMatch(/3 jeux gagnants/);
  });

  it("aucun jeu saisi → inachevé, jamais « 0-0 » présenté comme un résultat", () => {
    expect(checkScore(simple({ games: [] }))).toMatchObject({ ok: false, winner: null });
  });

  it("respecte le bestOf de la RENCONTRE (2 jeux gagnants en bo3)", () => {
    const s = checkScore(simple({ bestOf: 3, games: [{ home: 11, away: 5 }, { home: 11, away: 9 }] }));
    expect(s).toMatchObject({ ok: true, winner: "home" });
  });
});

describe("checkTie", () => {
  const gagne = (order: number, winner: "home" | "away") =>
    checkScore(
      simple({
        order,
        games:
          winner === "home"
            ? [{ home: 11, away: 5 }, { home: 11, away: 5 }, { home: 11, away: 5 }]
            : [{ home: 5, away: 11 }, { home: 5, away: 11 }, { home: 5, away: 11 }],
      }),
    );

  it("additionne les VAINQUEURS de simples, pas les jeux", () => {
    const t = checkTie([gagne(1, "home"), gagne(2, "home"), gagne(3, "away"), gagne(4, "away")], 4);
    expect(t).toMatchObject({ ok: true, home: 2, away: 2, undecided: 0, problem: null });
  });

  // Une rencontre à quatre simples dont un est inachevé s'afficherait « 2-1 » et aurait l'air
  // d'un score complet : c'est exactement ce qu'il ne faut pas laisser passer à la saisie.
  it("un simple sans vainqueur rend la rencontre incomplète, et le dit", () => {
    const inacheve = checkScore(simple({ order: 4, games: [{ home: 11, away: 5 }] }));
    const t = checkTie([gagne(1, "home"), gagne(2, "home"), gagne(3, "away"), inacheve], 4);
    expect(t).toMatchObject({ ok: false, home: 2, away: 1, undecided: 1 });
    expect(t.problem).toMatch(/sans vainqueur/);
  });

  it("des simples manquants sont signalés avant tout le reste", () => {
    const t = checkTie([gagne(1, "home")], 4);
    expect(t.ok).toBe(false);
    expect(t.problem).toMatch(/3 simple\(s\) manquant/);
  });
});

describe("countProblems", () => {
  const rapport = (over: Partial<CheckReport> = {}): CheckReport => ({
    checkedAt: "2026-09-10T10:00:00.000Z",
    players: [],
    scores: [],
    tie: { ok: true, home: 2, away: 2, undecided: 0, problem: null },
    ...over,
  });

  it("compte les joueurs non trouvés, les scores en défaut et le compte de la rencontre", () => {
    expect(countProblems(rapport())).toBe(0);
    const n = countProblems(
      rapport({
        players: [
          checkPlayer(1, "home", "Jean Dupont", [row("DUPONT JEAN")], YVETTE_CLUB), // ok
          checkPlayer(1, "away", "Paul Martin", [], "Autre"), // introuvable
        ],
        scores: [checkScore(simple()), checkScore(simple({ order: 2, games: [] }))],
        tie: { ok: false, home: 1, away: 0, undecided: 1, problem: "…" },
      }),
    );
    expect(n).toBe(3); // 1 joueur + 1 score + 1 rencontre
  });
});

describe("estRapportValide / lireRapport", () => {
  const bon = JSON.stringify({
    checkedAt: "2026-09-10T10:00:00.000Z",
    players: [],
    scores: [],
    tie: { ok: true, home: 2, away: 2, undecided: 0, problem: null },
  });

  it("relit un rapport bien formé", () => {
    expect(lireRapport(bon)?.tie.home).toBe(2);
  });

  // Le rapport est relu des semaines plus tard par un écran sans error boundary : « JSON
  // valide » ne suffit pas, un format antérieur passe `JSON.parse` puis lève au rendu.
  it("refuse un JSON valide mais d'un autre format, plutôt que de le laisser lever au rendu", () => {
    for (const mauvais of [
      "{}",
      '{"checkedAt":"x","players":[],"scores":[]}', // pas de `tie`
      '{"checkedAt":"x","players":[],"scores":[],"tie":{"home":2}}', // `tie` incomplet
      '{"checkedAt":1,"players":[],"scores":[],"tie":{"ok":true,"home":2,"away":2}}',
      "[]",
      "null",
    ]) {
      expect(estRapportValide(JSON.parse(mauvais))).toBe(false);
      expect(lireRapport(mauvais)).toBeNull();
    }
  });

  it("ne lève pas sur du texte qui n'est pas du JSON, ni sur l'absence de rapport", () => {
    expect(lireRapport("pas du json")).toBeNull();
    expect(lireRapport(null)).toBeNull();
  });
});
