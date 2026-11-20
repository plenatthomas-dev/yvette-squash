import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { SANS_BASE, ouvrirBaseDeTest } from "./pg-harness";
import type { TieLine, TieSheet } from "./squashnet/tie";

// SUR VRAIE BASE — le score corrigé après coup.
//
// Ce qu'on éprouve ici, et qu'un faux client ne dirait pas : que `reporterCorrection` réécrit
// bien les jeux et le score d'un simple importé, recalcule le score de la rencontre, garde
// l'heure d'un jeu inchangé — et ne touche pas un simple corrigé à la main dans l'appli.

// Hors sujet : le cache du direct (Next) et l'identité fédérale (rosters en base).
vi.mock("./interclub-gate", async (orig) => ({
  ...(await orig<typeof import("./interclub-gate")>()),
  interclubChanged: () => {},
}));

type Prisma = import("@prisma/client").PrismaClient;
let prisma: Prisma;
const MARQUEUR = "PG-TEST-correction";

const joueur = (name: string) => ({ name, regiid: null, clt: null, rang: null, rangM: null });
const ligne = (score: string, gamesA: number, gamesB: number, nous = "NOUS UN", eux = "EUX UN"): TieLine => ({
  label: "Homme",
  a: joueur(nous),
  b: joueur(eux),
  score,
  winner: gamesA > gamesB ? "A" : "B",
  gamesA,
  gamesB,
  pointsA: null,
  pointsB: null,
});
const feuille = (id: string, lines: TieLine[]): TieSheet => ({
  snTieId: id,
  codeA: "YVET1",
  codeB: "VERR3",
  division: null,
  group: null,
  round: "J4",
  venue: null,
  date: "2026-11-19",
  time: null,
  lines,
  totals: null,
});

describe.skipIf(SANS_BASE)("SUR VRAIE BASE — score corrigé après coup", () => {
  beforeAll(async () => {
    prisma = await ouvrirBaseDeTest();
    await prisma.interclubTeam.deleteMany({ where: { name: MARQUEUR } });
  });
  afterAll(async () => {
    const t = await prisma?.interclubTeam.findUnique({ where: { name: MARQUEUR } });
    if (t) {
      await prisma.interclub.deleteMany({ where: { teamId: t.id } });
      await prisma.interclubTeam.delete({ where: { id: t.id } });
    }
  });

  it("la correction de la ligue suit dans la rencontre importée, jamais sur une saisie à la main", async () => {
    const { importSheetResults, reporterCorrection } = await import("./interclub-sheet-import");
    const team = await prisma.interclubTeam.create({ data: { name: MARQUEUR } });

    // La première feuille : simple 1 gagné 3-1, simple 2 gagné 3-0. Rencontre 2-0.
    const ancienne = feuille("poule:J4:x", [
      ligne("11-6 11-3 8-11 11-0", 3, 1),
      ligne("11-1 11-2 11-3", 3, 0, "NOUS DEUX", "EUX DEUX"),
    ]);
    const ic = await prisma.interclub.create({
      data: {
        date: "2026-11-19",
        teamId: team.id,
        opponent: "Verrières 3",
        matchCount: 2,
        snSheetJson: JSON.stringify(ancienne),
        snSheetSide: "A",
        matches: {
          create: [1, 2].map((order) => ({ order, homeDisplayName: "À désigner", awayName: "À désigner" })),
        },
      },
    });
    expect(await importSheetResults(team.id, new Date("2026-11-20T12:00:00Z"))).toBe(1);

    // Le simple 2 est retouché À LA MAIN dans l'appli (3-1 au lieu de 3-0).
    const m2 = await prisma.interclubMatch.findFirstOrThrow({ where: { interclubId: ic.id, order: 2 } });
    await prisma.interclubGame.create({ data: { matchId: m2.id, number: 4, pointsHome: 11, pointsAway: 9 } });
    await prisma.interclubGame.update({
      where: { matchId_number: { matchId: m2.id, number: 3 } },
      data: { pointsHome: 9, pointsAway: 11 },
    });
    await prisma.interclubMatch.update({ where: { id: m2.id }, data: { gamesHome: 3, gamesAway: 1 } });

    // Un jeu du simple 1 porte une heure (marquage en direct) : elle doit survivre.
    const m1 = await prisma.interclubMatch.findFirstOrThrow({ where: { interclubId: ic.id, order: 1 } });
    const heure = new Date("2026-11-19T19:30:00Z");
    await prisma.interclubGame.update({
      where: { matchId_number: { matchId: m1.id, number: 1 } },
      data: { finishedAt: heure },
    });

    // La ligue corrige : simple 1 PERDU 2-3, simple 2 inchangé… sauf qu'on le change aussi, pour
    // vérifier qu'une saisie manuelle n'est pas écrasée.
    const officielle = feuille("100", [
      ligne("11-6 3-11 8-11 11-0 5-11", 2, 3),
      ligne("11-1 11-2 11-4", 3, 0, "NOUS DEUX", "EUX DEUX"),
    ]);
    await prisma.interclub.update({
      where: { id: ic.id },
      data: { snSheetJson: JSON.stringify(officielle), snSheetSide: "A" },
    });
    expect(await reporterCorrection(ic.id, JSON.stringify(ancienne), "A")).toBe(1);

    const apres = await prisma.interclub.findUniqueOrThrow({
      where: { id: ic.id },
      include: { matches: { orderBy: { order: "asc" }, include: { games: { orderBy: { number: "asc" } } } } },
    });
    const [s1, s2] = apres.matches;
    expect([s1.gamesHome, s1.gamesAway]).toEqual([2, 3]);
    expect(s1.games.map((g) => `${g.pointsHome}-${g.pointsAway}`)).toEqual(["11-6", "3-11", "8-11", "11-0", "5-11"]);
    expect(s1.games[0].finishedAt?.toISOString()).toBe(heure.toISOString());
    expect(s1.games[1].finishedAt).toBeNull();
    // La saisie manuelle du simple 2 est intacte.
    expect([s2.gamesHome, s2.gamesAway]).toEqual([3, 1]);
    expect(s2.games).toHaveLength(4);
    // Le score annoncé suit en silence : 1-1.
    expect(apres.status).toBe("done");
    expect(apres.doneNotifiedScore).toBe("1-1");
  });
});
