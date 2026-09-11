import { describe, it, expect } from "vitest";
import {
  checkAwayOrder,
  checkPlayer,
  queryTerms,
  playerFromRoster,
  clubOfTeam,
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
import type { TeamRoster } from "./squashnet/roster";
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

// LE BOGUE QUI RENDAIT TOUS LES ADVERSAIRES INTROUVABLES sur une équipe numérotée. Le
// calendrier fédéral donne un nom d'ÉQUIPE (« Chaville 4 »), le classement range sous le CLUB
// (« Chaville ») : comparés tels quels, ils ne coïncident jamais. Et le remède affiché envoyait
// corriger une orthographe parfaitement juste.
describe("clubOfTeam", () => {
  it("retire le numéro d'équipe, et lui seul", () => {
    expect(clubOfTeam("Chaville 4")).toBe("Chaville");
    expect(clubOfTeam("UCPA Meudon 2")).toBe("UCPA Meudon");
    expect(clubOfTeam("Liberty Country Club 3")).toBe("Liberty Country Club");
  });

  it("laisse intact un club sans numéro", () => {
    expect(clubOfTeam("Squash de l'Yvette")).toBe("Squash de l'Yvette");
    expect(clubOfTeam("  Squash de l'Yvette  ")).toBe("Squash de l'Yvette");
  });

  it("ne rend jamais une chaîne vide, même sur un libellé qui n'est qu'un nombre", () => {
    // « 4 » n'est un nom de club chez personne, mais rendre « » ferait comparer au vide —
    // et le vide, normalisé, coïncide avec tout ce qui est vide.
    expect(clubOfTeam("4")).toBe("4");
  });

  it("un nombre AU MILIEU du nom n'est pas un numéro d'équipe", () => {
    expect(clubOfTeam("Squash 2000 Paris")).toBe("Squash 2000 Paris");
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
    awayOrder: { status: "ok", problem: null },
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

describe("checkAwayOrder — la règle fédérale vaut aussi en face", () => {
  /** Un adversaire rapproché, avec son classement et son rang. */
  const eux = (order: number, clt: string, rangM: number | null) =>
    checkPlayer(order, "away", `Joueur ${order}`, [row(`JOUEUR ${order}`, { clt, rangM: String(rangM ?? 0), club: "Rennes" })], "Rennes");

  /** Un adversaire que la fédération n'a pas confirmé. */
  const inconnu = (order: number) => checkPlayer(order, "away", `Fantôme ${order}`, [], "Rennes");

  it("ordre conforme (du mieux classé au moins bon) → ok, sans un mot", () => {
    const r = checkAwayOrder([eux(1, "4A", 100), eux(2, "5A", 900)]);
    expect(r).toEqual({ status: "ok", problem: null });
  });

  // LE contrôle demandé : le mieux classé doit jouer le simple n° 1.
  it("un mieux classé sur un simple TARDIF → violation", () => {
    const r = checkAwayOrder([eux(1, "5A", 900), eux(2, "4A", 100)]);
    expect(r.status).toBe("violation");
    expect(r.problem).toMatch(/mieux classé/);
  });

  it("à classement égal, c'est le rang mixte qui départage", () => {
    expect(checkAwayOrder([eux(1, "5A", 100), eux(2, "5A", 900)]).status).toBe("ok");
    expect(checkAwayOrder([eux(1, "5A", 900), eux(2, "5A", 100)]).status).toBe("violation");
  });

  // ⚠️ LE POINT DÉLICAT. Notre lecture de leurs classements passe par un rapprochement de noms
  // recopiés à la main : accuser sur une base incomplète enverrait contester une composition
  // parfaitement régulière.
  it("un seul adversaire non rapproché suffit à NE PAS conclure", () => {
    const r = checkAwayOrder([eux(1, "5A", 900), eux(2, "4A", 100), inconnu(3)]);
    // L'ordre est pourtant rompu entre les deux premiers — on se tait quand même.
    expect(r.status).toBe("unverifiable");
    expect(r.problem).toMatch(/non vérifié/);
  });

  it("hors NC, un rang manquant empêche aussi de conclure", () => {
    const sansRang = checkPlayer(2, "away", "Sans Rang", [row("SANS RANG", { clt: "5A", rangM: "0", club: "Rennes" })], "Rennes");
    expect(checkAwayOrder([eux(1, "5A", 100), sansRang]).status).toBe("unverifiable");
  });

  it("les NC sont équivalents entre eux, et n'exigent aucun rang", () => {
    const nc = (order: number) =>
      checkPlayer(order, "away", `NC ${order}`, [row(`NC ${order}`, { clt: "NC", rangM: "0", club: "Rennes" })], "Rennes");
    expect(checkAwayOrder([nc(1), nc(2)]).status).toBe("ok");
  });

  it("moins de deux adversaires → rien à ordonner", () => {
    expect(checkAwayOrder([eux(1, "5A", 100)]).status).toBe("ok");
    expect(checkAwayOrder([]).status).toBe("ok");
  });

  // La règle porte sur la composition d'EN FACE : la nôtre est déjà refusée à la saisie
  // (`lineupOrderConflict`), et la revérifier ici doublerait un message qu'on a déjà eu.
  it("ignore nos propres joueurs", () => {
    const nous = checkPlayer(1, "home", "Jean Dupont", [row("DUPONT JEAN")], YVETTE_CLUB);
    expect(checkAwayOrder([nous]).status).toBe("ok");
  });

  it("n'accuse jamais : le message invite à vérifier la feuille de match", () => {
    const r = checkAwayOrder([eux(1, "5A", 900), eux(2, "4A", 100)]);
    expect(r.problem).toMatch(/À vérifier sur la feuille de match/);
  });
});

describe("estRapportValide / lireRapport", () => {
  const bon = JSON.stringify({
    checkedAt: "2026-09-10T10:00:00.000Z",
    players: [],
    scores: [],
    tie: { ok: true, home: 2, away: 2, undecided: 0, problem: null },
    awayOrder: { status: "ok", problem: null },
  });

  it("relit un rapport bien formé", () => {
    expect(lireRapport(bon)?.tie.home).toBe(2);
  });

  // Le rapport est relu des semaines plus tard par un écran sans error boundary : « JSON
  // valide » ne suffit pas, un format antérieur passe `JSON.parse` puis lève au rendu.
  it("refuse un JSON valide mais d'un autre format, plutôt que de le laisser lever au rendu", () => {
    for (const mauvais of [
      "{}",
      // Un rapport d'AVANT le contrôle d'ordre : valide hier, illisible aujourd'hui. C'est
      // exactement ce que la garde existe pour attraper — l'écran lit `awayOrder.status`.
      '{"checkedAt":"x","players":[],"scores":[],"tie":{"ok":true,"home":2,"away":2}}',
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

// ============================================================================
//  LE VERDICT LU DANS LE ROSTER — et le contresens qu'il fait disparaître.
//
//  Constaté en vrai sur Verrieres 3 : le rapprochement par le nom cherche au
//  classement NATIONAL, tombe sur un homonyme d'un autre club et annonce
//  « LOUVEAU FLORENT rattaché à l'Association sportive du squash club de
//  Valence : vérifie le nom du club adverse ». Le nom du club adverse était
//  juste, le joueur bien là, et le capitaine envoyé corriger ce qui n'avait
//  rien. Quatre joueurs sur quatre, sur une rencontre déjà jouée.
// ============================================================================

const rosterVerrieres: TeamRoster = {
  snTeamId: "161095",
  // Aucune rencontre : ces bancs d'essai portent sur les JOUEURS, pas sur le calendrier.
  ties: [],
  teamName: "Verrieres 3",
  code: "VERR3",
  club: "Squash club verrieres le buisson",
  captain: null,
  players: [
    {
      name: "LOUVEAU FLORENT",
      gender: "Mr.",
      licence: "1404133H",
      clt: "5C",
      rang: 5822,
      rangM: 5822,
      registeredAt: "2025-09-22",
    },
    {
      name: "FARRACHI VINCENT",
      gender: "Mr.",
      licence: "0113258",
      clt: "5D",
      rang: 7258,
      rangM: 7258,
      registeredAt: "2025-09-22",
    },
  ],
};

describe("playerFromRoster", () => {
  it("confirme le joueur inscrit, avec sa licence, SANS aucune recherche", () => {
    const p = playerFromRoster(1, "LOUVEAU FLORENT", rosterVerrieres);
    expect(p).toEqual({
      order: 1,
      side: "away",
      name: "LOUVEAU FLORENT",
      verdict: "found",
      fedName: "LOUVEAU FLORENT",
      clt: "5C",
      rangM: 5822,
      licence: "1404133H",
      club: "Squash club verrieres le buisson",
      hint: null,
    });
  });

  it("ne peut PAS confondre avec l'homonyme d'un autre club", () => {
    // Le roster ne contient que les joueurs que CE club a inscrits dans CETTE équipe : il n'y a
    // aucune sélection à faire, donc aucune mauvaise sélection possible. C'est toute la
    // différence avec `checkPlayer`, qui doit choisir dans un classement national.
    const p = playerFromRoster(1, "LOUVEAU FLORENT", rosterVerrieres);
    expect(p?.verdict).toBe("found");
    expect(p?.club).not.toContain("Valence");
    expect(p?.hint).toBeNull();
  });

  it("apparie malgré la casse, les accents et l'ordre des mots", () => {
    // La feuille de match porte « Florent Louveau », la ligue « LOUVEAU FLORENT ».
    expect(playerFromRoster(1, "Florent Louveau", rosterVerrieres)?.licence).toBe("1404133H");
    expect(playerFromRoster(1, "  vincent farrachi ", rosterVerrieres)?.licence).toBe("0113258");
  });

  it("rend le nom FÉDÉRAL, qui est celui à recopier chez la ligue", () => {
    expect(playerFromRoster(1, "Florent Louveau", rosterVerrieres)?.fedName).toBe(
      "LOUVEAU FLORENT",
    );
  });

  it("rend null sur un joueur que la ligue n'a pas inscrit — la recherche prend le relais", () => {
    // Mutation tardive, inscription oubliée : il a joué, il existe. On ne conclut rien ici,
    // l'appelant retombe sur le rapprochement par le nom.
    expect(playerFromRoster(1, "Jean Nouveau", rosterVerrieres)).toBeNull();
  });

  it("rend null sans roster, et sur un nom vide", () => {
    expect(playerFromRoster(1, "LOUVEAU FLORENT", null)).toBeNull();
    expect(playerFromRoster(1, "  ", rosterVerrieres)).toBeNull();
  });

  it("ne replie pas une vraie faute de frappe", () => {
    expect(playerFromRoster(1, "LOUVAU FLORENT", rosterVerrieres)).toBeNull();
  });
});

// ============================================================================
//  LE TERME DE RECHERCHE — et pourquoi il y en a deux.
//
//  Mesuré sur le classement du 2026-09-01 (squashnet, `ic_a=131079`) :
//    « DETRY » → 1        « DE ABREU » → 1       « DETRY XAVIER » → 0
//    « XAVIER » → 62      « ABREU »    → 2       « DE »           → 99
//
//  Le nom COMPLET n'est pas accepté : la recherche porte sur le nom de famille
//  OU le prénom, jamais à cheval. Il faut donc choisir un mot — et on ne sait
//  pas de quel côté est le nom de famille.
// ============================================================================

describe("queryTerms", () => {
  it("essaie le dernier mot d'abord — l'ordre français est le cas courant", () => {
    // `homeDisplayName` et toute saisie à la main sont en « Prénom Nom » : le second appel
    // n'aura jamais lieu pour eux.
    expect(queryTerms("Xavier Detry")).toEqual(["Detry", "Xavier"]);
  });

  it("rattrape l'ordre FÉDÉRAL par son second terme", () => {
    // Depuis que le menu propose l'identité fédérale, « DETRY XAVIER » est une saisie naturelle.
    // Avec le seul dernier mot, on cherchait « XAVIER » — 62 résultats paginés, et un verdict
    // « introuvable » sur un nom parfaitement juste.
    expect(queryTerms("DETRY XAVIER")).toEqual(["XAVIER", "DETRY"]);
  });

  // ⚠️ LE CAS QUI CASSAIT UN CHOIX NAÏF DU PREMIER MOT. « Le Marquis Xavier » commence par la
  // particule, c'est-à-dire par le mot le moins discriminant de tous : « DE » seul rend 99
  // résultats. On l'écarte du choix du terme.
  it("écarte les particules d'un nom composé, dans les DEUX ordres", () => {
    expect(queryTerms("Le Marquis Xavier")).toEqual(["Xavier", "Marquis"]);
    expect(queryTerms("Xavier Le Marquis")).toEqual(["Marquis", "Xavier"]);
    expect(queryTerms("De Abreu Paulo")).toEqual(["Paulo", "Abreu"]);
    expect(queryTerms("Paulo De Abreu")).toEqual(["Abreu", "Paulo"]);
  });

  it("n'a pas besoin du nom composé ENTIER — une partie suffit chez eux", () => {
    // Mesuré : « ABREU » retrouve « DE ABREU ». On ne reconstitue donc jamais « Le Marquis ».
    expect(queryTerms("Van Der Berg Jean")).toEqual(["Jean", "Berg"]);
  });

  it("reconnaît les particules quelle que soit leur casse ou leurs accents", () => {
    expect(queryTerms("LE MARQUIS XAVIER")).toEqual(["XAVIER", "MARQUIS"]);
    expect(queryTerms("Da Silva Joao")).toEqual(["Joao", "Silva"]);
  });

  it("ne rend qu'UN terme sur un nom d'un seul mot significatif", () => {
    // L'essayer deux fois serait une requête offerte à squashnet pour une réponse déjà connue.
    expect(queryTerms("Detry")).toEqual(["Detry"]);
    expect(queryTerms("Le Marquis")).toEqual(["Marquis"]);
  });

  it("retombe sur les jetons bruts plutôt que sur rien", () => {
    // Un nom qui ne serait QUE des particules n'existe pas, mais rendre une liste vide
    // signifierait « aucune recherche possible » — donc un « introuvable » muet.
    expect(queryTerms("De La")).toEqual(["La", "De"]);
    expect(queryTerms("   ")).toEqual([]);
  });

  it("queryOf reste le terme le plus prometteur", () => {
    expect(queryOf("Xavier Detry")).toBe("Detry");
    expect(queryOf("Le Marquis Xavier")).toBe("Xavier");
    expect(queryOf("")).toBe("");
  });
});
