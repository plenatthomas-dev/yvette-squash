import { describe, it, expect } from "vitest";
import {
  awayLineupConflict,
  estDesigne,
  mergeOpponents,
  opponentTeams,
  type KnownOpponent,
  type OpponentSource,
} from "./interclub-opponents";

/** Un rapport de vérification capitaine, réduit à ce que la fusion y lit. */
function rapport(
  players: { name: string; fedName?: string; clt?: string; rangM?: number | null; licence?: string; side?: "home" | "away"; verdict?: string }[],
) {
  return JSON.stringify({
    checkedAt: "2026-09-01T10:00:00.000Z",
    players: players.map((p, i) => ({
      order: i + 1,
      side: p.side ?? "away",
      name: p.name,
      verdict: p.verdict ?? "found",
      fedName: p.fedName ?? p.name.toUpperCase(),
      clt: p.clt ?? "5A",
      rangM: p.rangM === undefined ? 2000 : p.rangM,
      licence: p.licence ?? "0121214",
      club: "Chaville",
      hint: null,
    })),
    scores: [],
    tie: { ok: true, home: 2, away: 2, undecided: 0, problem: null },
    awayOrder: { status: "ok", problem: null },
  });
}

const src = (over: Partial<OpponentSource> = {}): OpponentSource => ({
  opponent: "Chaville 4",
  matches: [{ awayName: "Paul Martin" }],
  checkJson: null,
  ...over,
});

describe("estDesigne", () => {
  it("ne prend un simple non composé pour personne, quelle que soit sa casse", () => {
    expect(estDesigne("À désigner")).toBe(false);
    expect(estDesigne("a designer")).toBe(false);
    expect(estDesigne("  ")).toBe(false);
    expect(estDesigne(null)).toBe(false);
    expect(estDesigne("Paul Martin")).toBe(true);
  });
});

describe("mergeOpponents", () => {
  it("ne remonte que des joueurs — ni case vide, ni « à désigner »", () => {
    const out = mergeOpponents([
      src({ matches: [{ awayName: "Paul Martin" }, { awayName: "À désigner" }, { awayName: "  " }] }),
    ]);
    expect(out.map((o) => o.name)).toEqual(["Paul Martin"]);
  });

  // C'EST LE PROBLÈME QUE LE MENU RÉSOUT : trois orthographes d'un même joueur, trois entrées, et
  // le rapprochement fédéral qui échoue deux fois sur trois. La fusion doit les ramener à une.
  it("ne propose qu'UNE fois un joueur écrit de trois façons", () => {
    const out = mergeOpponents([
      src({ matches: [{ awayName: "Detry" }] }),
      src({ matches: [{ awayName: "DÉTRY" }] }),
      src({ matches: [{ awayName: "  detry  " }] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].seen).toBe(3);
  });

  it("retient la DERNIÈRE orthographe — c'est la correction la plus récente", () => {
    const out = mergeOpponents([
      src({ matches: [{ awayName: "detry" }] }),
      src({ matches: [{ awayName: "Détry" }] }),
    ]);
    expect(out[0].name).toBe("Détry");
  });

  // CE QUE LE MODULE NE FAIT PAS, et ne prétend pas faire : une faute de frappe reste un autre
  // joueur. C'est le MENU qui la traite, en rendant la ressaisie inutile.
  it("ne rapproche pas deux orthographes réellement différentes", () => {
    const out = mergeOpponents([
      src({ matches: [{ awayName: "Detri" }] }),
      src({ matches: [{ awayName: "Detry" }] }),
    ]);
    expect(out).toHaveLength(2);
  });

  // Deux clubs peuvent avoir un homonyme, et surtout : le menu se filtre par équipe. Confondre
  // les deux proposerait un joueur de Chaville dans la composition contre Meudon.
  it("sépare deux homonymes de clubs différents", () => {
    const out = mergeOpponents([
      src({ opponent: "Chaville 4", matches: [{ awayName: "Paul Martin" }] }),
      src({ opponent: "UCPA Meudon 2", matches: [{ awayName: "Paul Martin" }] }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((o) => o.team).sort()).toEqual(["Chaville 4", "UCPA Meudon 2"]);
  });

  it("raccroche l'identité fédérale au nom saisi, sans dépendre de l'ordre des simples", () => {
    const out = mergeOpponents([
      src({
        matches: [{ awayName: "Paul Martin" }],
        // Le rapport le donne en simple n° 3 : c'est le NOM qui raccroche, pas la position.
        checkJson: rapport([
          { name: "Autre Joueur" },
          { name: "Encore Un" },
          { name: "paul martin", fedName: "MARTIN PAUL", clt: "4D", rangM: 2318, licence: "0121214" },
        ]),
      }),
    ]);
    expect(out[0]).toMatchObject({ fedName: "MARTIN PAUL", clt: "4D", rangM: 2318, licence: "0121214" });
  });

  // Une vérification muette (squashnet en panne) ne doit pas effacer ce qu'une vérification
  // aboutie avait appris : sans quoi l'ordre des simples redeviendrait invérifiable au hasard des
  // pannes d'en face.
  it("ne perd pas une identité confirmée parce qu'une vérification ultérieure n'a rien conclu", () => {
    const out = mergeOpponents([
      src({ checkJson: rapport([{ name: "Paul Martin", clt: "4D", rangM: 2318 }]) }),
      src({ checkJson: rapport([{ name: "Paul Martin", verdict: "unknown" }]) }),
    ]);
    expect(out[0]).toMatchObject({ clt: "4D", rangM: 2318 });
  });

  it("ignore un joueur DE CHEZ NOUS présent dans le rapport", () => {
    const out = mergeOpponents([
      src({
        matches: [{ awayName: "Jean Dupont" }],
        checkJson: rapport([{ name: "Jean Dupont", side: "home", clt: "2A", rangM: 12 }]),
      }),
    ]);
    // Le nom vient de `awayName`, donc il est bien là — mais sans l'identité d'un homonyme
    // de notre camp, qui rendrait l'ordre des simples adverses faux.
    expect(out[0]).toMatchObject({ name: "Jean Dupont", clt: null, rangM: null });
  });

  it("ne survit pas à un checkJson illisible", () => {
    const out = mergeOpponents([src({ checkJson: "{{{" })]);
    expect(out[0]).toMatchObject({ name: "Paul Martin", clt: null });
  });

  // Les confirmés d'abord : ce sont les seuls sur lesquels l'ordre peut être vérifié, donc les
  // seuls qui n'entraîneront pas un refus muet plus tard.
  it("met les joueurs confirmés en tête, puis les plus souvent croisés", () => {
    const out = mergeOpponents([
      src({ matches: [{ awayName: "Zoe Inconnue" }] }),
      src({ matches: [{ awayName: "Zoe Inconnue" }] }),
      src({
        matches: [{ awayName: "Alice Connue" }],
        checkJson: rapport([{ name: "Alice Connue", clt: "4D", rangM: 100 }]),
      }),
    ]);
    expect(out.map((o) => o.name)).toEqual(["Alice Connue", "Zoe Inconnue"]);
  });
});

describe("opponentTeams", () => {
  it("dédoublonne à l'accent près et trie alphabétiquement", () => {
    expect(
      opponentTeams([
        { opponent: "UCPA Meudon 2" },
        { opponent: "Chaville 4" },
        { opponent: "chaville 4" },
        { opponent: "  " },
      ]),
    ).toEqual(["Chaville 4", "UCPA Meudon 2"]);
  });

  // Un nom d'ÉQUIPE vient de l'import du calendrier fédéral, jamais d'une correction : une
  // variante saisie plus tard dégrade l'orthographe officielle au lieu de la corriger.
  it("garde l'orthographe de l'import, pas la saisie manuelle qui a suivi", () => {
    expect(opponentTeams([{ opponent: "Chaville 4" }, { opponent: "chaville 4" }])).toEqual([
      "Chaville 4",
    ]);
  });
});

describe("awayLineupConflict", () => {
  const connu = (name: string, clt: string, rangM: number | null): KnownOpponent => ({
    name,
    team: "Chaville 4",
    fedName: name.toUpperCase(),
    clt,
    rangM,
    licence: "0121214",
    seen: 1,
  });

  const ligne = (order: number, awayName: string) => ({ order, awayName });

  it("refuse un mieux classé placé APRÈS un moins bien classé", () => {
    const out = awayLineupConflict(
      [ligne(1, "Paul Martin"), ligne(2, "Luc Bernard")],
      [connu("Paul Martin", "5A", 2000), connu("Luc Bernard", "4A", 100)],
    );
    expect(out).toMatch(/^Ordre des simples adverses — /);
    expect(out).toContain("LUC BERNARD");
  });

  it("accepte l'ordre décroissant", () => {
    expect(
      awayLineupConflict(
        [ligne(1, "Luc Bernard"), ligne(2, "Paul Martin")],
        [connu("Paul Martin", "5A", 2000), connu("Luc Bernard", "4A", 100)],
      ),
    ).toBeNull();
  });

  it("départage deux ex æquo par le rang mixte, comme chez nous", () => {
    expect(
      awayLineupConflict(
        [ligne(1, "Paul Martin"), ligne(2, "Luc Bernard")],
        [connu("Paul Martin", "5A", 2000), connu("Luc Bernard", "5A", 100)],
      ),
    ).toContain("à classement égal");
  });

  // ⚠️ LA DIFFÉRENCE IRRÉDUCTIBLE AVEC NOTRE CAMP. `lineupOrderConflict` refuse un joueur sans
  // classement ; en face, le refuser rendrait impossible d'inscrire une première rencontre contre
  // un club jamais croisé — le cas le plus banal d'un début de saison.
  it("ne conclut RIEN si un seul des désignés nous est inconnu", () => {
    expect(
      awayLineupConflict(
        [ligne(1, "Paul Martin"), ligne(2, "Jamais Vu")],
        [connu("Paul Martin", "5A", 2000)],
      ),
    ).toBeNull();
  });

  it("ne conclut rien sur un adversaire croisé mais jamais confirmé", () => {
    expect(
      awayLineupConflict(
        [ligne(1, "Paul Martin"), ligne(2, "Luc Bernard")],
        [connu("Paul Martin", "5A", 2000), connu("Luc Bernard", null as unknown as string, null)],
      ),
    ).toBeNull();
  });

  // Deux « 5A » dans le mauvais sens passeraient pour conformes sans leur rang : mieux vaut se
  // taire que valider à tort.
  it("ne conclut rien sur un non-NC dont le rang mixte manque", () => {
    expect(
      awayLineupConflict(
        [ligne(1, "Paul Martin"), ligne(2, "Luc Bernard")],
        [connu("Paul Martin", "5A", 2000), connu("Luc Bernard", "5A", null)],
      ),
    ).toBeNull();
  });

  // Les NC sont équivalents entre eux : la fédération ne les ordonne pas, donc leur rang mixte
  // n'est pas exigé — sans quoi une équipe entièrement non classée serait incomposable.
  it("ordonne des NC sans rang mixte, et ne les refuse jamais entre eux", () => {
    expect(
      awayLineupConflict(
        [ligne(1, "Paul Martin"), ligne(2, "Luc Bernard")],
        [connu("Paul Martin", "NC", null), connu("Luc Bernard", "NC", null)],
      ),
    ).toBeNull();
  });

  it("un seul désigné ne peut rompre aucun ordre", () => {
    expect(
      awayLineupConflict(
        [ligne(1, "À désigner"), ligne(2, "Luc Bernard")],
        [connu("Luc Bernard", "4A", 100)],
      ),
    ).toBeNull();
  });

  // Les « à désigner » se retirent AVANT la comparaison : sinon un trou au simple n° 1 décalerait
  // les numéros et inventerait un conflit là où il n'y en a pas.
  it("compare les désignés sur LEUR numéro de simple, trous compris", () => {
    expect(
      awayLineupConflict(
        [ligne(1, "À désigner"), ligne(2, "Luc Bernard"), ligne(3, "Paul Martin")],
        [connu("Paul Martin", "5A", 2000), connu("Luc Bernard", "4A", 100)],
      ),
    ).toBeNull();
  });

  it("raccroche le connu à l'orthographe près", () => {
    expect(
      awayLineupConflict(
        [ligne(1, "  paul MARTIN "), ligne(2, "Luc Bernard")],
        [connu("Paul Martin", "5A", 2000), connu("Luc Bernard", "4A", 100)],
      ),
    ).toMatch(/^Ordre des simples adverses — /);
  });
});
