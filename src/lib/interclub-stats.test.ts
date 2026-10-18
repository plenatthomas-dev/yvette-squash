import { describe, it, expect } from "vitest";
import {
  feuilleComplete,
  identityResolver,
  lireCote,
  lireFeuille,
  nomLisible,
  playerStats,
  type AppPlayer,
  type OfficialFixture,
  type StatIdentity,
} from "./interclub-stats";
import type { TieLine, TieSheet } from "./squashnet/tie";

// LE PALMARÈS, CALCULÉ SUR LA FEUILLE OFFICIELLE.
//
// Le point de départ de ce module : une soirée que personne n'a marquée dans l'appli doit
// compter quand même. Tout ce qui suit est donc lu sur la feuille que la ligue publie — et les
// pièges sont ceux de cette feuille : « A » et « B » ne disent pas qui nous sommes, un simple
// non saisi n'est pas une défaite, et la feuille ne connaît que des noms fédéraux.

const joueur = (name: string) => ({ name, regiid: null, clt: null, rang: null, rangM: null });

/** Un simple : `nous` côté A par défaut, gagné 3-1. */
const simple = (over: Partial<TieLine> = {}): TieLine => ({
  label: "Homme 1",
  a: joueur("POPULU AXEL"),
  b: joueur("DUPONT JEAN"),
  score: "11-6 11-3 8-11 11-0",
  winner: "A",
  gamesA: 3,
  gamesB: 1,
  pointsA: 41,
  pointsB: 20,
  ...over,
});

const feuille = (lines: TieLine[], over: Partial<TieSheet> = {}): TieSheet => ({
  snTieId: "1",
  codeA: "YVET1",
  codeB: "VERR2",
  division: null,
  group: null,
  round: null,
  venue: null,
  date: null,
  time: null,
  lines,
  totals: null,
  ...over,
});

/** Identité par nom fédéral, sans appli derrière. */
const parNom = (fedName: string): StatIdentity => ({ key: "n:" + fedName, name: fedName, isMember: false });

const sur = (side: "A" | "B" | null, ...lines: TieLine[]): OfficialFixture => ({ sheet: feuille(lines), side });

describe("playerStats — sur la feuille officielle", () => {
  it("compte les matchs, les victoires, les jeux et les points", () => {
    const rows = playerStats(
      [
        sur("A", simple()),
        sur("A", simple({ winner: "B", gamesA: 1, gamesB: 3, pointsA: 30, pointsB: 42 })),
        sur("A", simple({ gamesA: 3, gamesB: 0, pointsA: 33, pointsB: 10 })),
      ],
      parNom,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "POPULU AXEL", played: 3, won: 2, lost: 1 });
    expect(rows[0].winRate).toBeCloseTo(2 / 3);
    expect(rows[0].games).toEqual({ won: 7, lost: 4, diff: 3 });
    expect(rows[0].rallies).toEqual({ won: 104, lost: 72, diff: 32 });
  });

  it("LIT NOTRE CÔTÉ : côté B, ce sont les joueurs de B et leurs jeux qui comptent", () => {
    const rows = playerStats([sur("B", simple())], parNom);
    expect(rows).toEqual([
      expect.objectContaining({ name: "DUPONT JEAN", played: 1, won: 0, lost: 1, games: { won: 1, lost: 3, diff: -2 } }),
    ]);
  });

  it("IGNORE une feuille dont notre côté est inconnu — compter à l'envers serait pire", () => {
    expect(playerStats([sur(null, simple())], parNom)).toEqual([]);
  });

  it("NE COMPTE PAS un simple non tranché, ni un simple sans joueur de notre côté", () => {
    const rows = playerStats(
      [sur("A", simple({ winner: null, gamesA: null, gamesB: null }), simple({ label: "Homme 2", a: null, winner: "B" }))],
      parNom,
    );
    expect(rows).toEqual([]);
  });

  it("TAIT les jeux et les points dès qu'un seul simple ne les publie pas", () => {
    const rows = playerStats([sur("A", simple()), sur("A", simple({ gamesA: null, pointsA: null }))], parNom);
    expect(rows[0]).toMatchObject({ played: 2, won: 2, games: null, rallies: null });
  });

  it("classe par VICTOIRES et non par pourcentage", () => {
    const rows = playerStats(
      [
        sur("A", simple({ a: joueur("UN SEUL") })),
        sur("A", simple({ a: joueur("REGULIER") })),
        sur("A", simple({ a: joueur("REGULIER") })),
        sur("A", simple({ a: joueur("REGULIER"), winner: "B" })),
      ],
      parNom,
    );
    expect(rows.map((r) => r.name)).toEqual(["REGULIER", "UN SEUL"]);
  });

  it("rend une liste vide sans rien inventer", () => {
    expect(playerStats([], parNom)).toEqual([]);
  });
});

describe("identityResolver — du nom fédéral au joueur de l'appli", () => {
  const thomas: AppPlayer = { kind: "member", id: "u1", name: "Tom", licence: "123A" };
  const invite: AppPlayer = { kind: "guest", id: "g1", name: "Jean Dupont", licence: null };

  it("relie par LICENCE, quel que soit le nom affiché", () => {
    const id = identityResolver([thomas], [{ name: "PLENAT THOMAS", licence: "123a" }]);
    expect(id("PLENAT THOMAS")).toEqual({ key: "u:u1", name: "Tom", isMember: true });
  });

  it("relie par NOM à défaut, ordre des mots indifférent", () => {
    const id = identityResolver([invite], []);
    expect(id("DUPONT JEAN")).toEqual({ key: "g:g1", name: "Jean Dupont", isMember: false });
  });

  it("utilise les noms de recherche fédérale d'un membre", () => {
    const id = identityResolver([{ ...thomas, licence: null, altNames: ["Plenat Thomas"] }], []);
    expect(id("PLENAT THOMAS").key).toBe("u:u1");
  });

  it("NE TRANCHE PAS entre deux homonymes : le joueur garde son nom fédéral", () => {
    const id = identityResolver(
      [invite, { kind: "member", id: "u2", name: "Jean Dupont", licence: null }],
      [],
    );
    expect(id("DUPONT JEAN")).toEqual({ key: "n:dupont jean", name: "Dupont Jean", isMember: false });
  });

  it("garde un joueur inconnu de l'appli sous son nom fédéral, lisible", () => {
    expect(identityResolver([], [])("LE GALL ANNE-MARIE")).toMatchObject({
      name: "Le Gall Anne-Marie",
      isMember: false,
    });
  });
});

describe("lireFeuille / lireCote / feuilleComplete", () => {
  it("relit une feuille sérialisée", () => {
    const f = feuille([simple()]);
    expect(lireFeuille(JSON.stringify(f))).toEqual(f);
  });

  it("refuse un JSON illisible ou d'une autre forme plutôt que de lever au calcul", () => {
    expect(lireFeuille("{")).toBeNull();
    expect(lireFeuille(JSON.stringify({ snTieId: "1", lines: [{ label: 3 }] }))).toBeNull();
    expect(lireFeuille(null)).toBeNull();
  });

  it("n'accepte que A ou B pour notre côté", () => {
    expect(lireCote("A")).toBe("A");
    expect(lireCote("C")).toBeNull();
    expect(lireCote(null)).toBeNull();
  });

  it("une feuille est complète quand chaque simple est saisi ET tranché", () => {
    expect(feuilleComplete(feuille([simple(), simple({ label: "Homme 2" })]))).toBe(true);
    expect(feuilleComplete(feuille([simple(), simple({ winner: null })]))).toBe(false);
    expect(feuilleComplete(feuille([]))).toBe(false);
  });

  it("nomLisible met en casse de titre", () => {
    expect(nomLisible("POPULU AXEL")).toBe("Populu Axel");
  });
});
