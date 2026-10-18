import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ficheEquipe, ficheJoueur } from "./interclub-team-sheet";
import { parsePool } from "./squashnet/pool";
import { parseTeamRoster } from "./squashnet/roster";
import { parsePlayer } from "./squashnet/player";

// LA FICHE D'UNE ÉQUIPE ET CELLE D'UN JOUEUR, assemblées sur les vrais fragments du 2026-10-18 :
// la poule B des Hommes 4, la fiche d'équipe de Squash in Issy, la fiche joueur de Rafik Kadi.
// Les chiffres attendus sont ceux de l'appli Squash App sur les mêmes écrans.

const lire = (f: string) => readFileSync(join(__dirname, "squashnet", "__fixtures__", f), "utf8");
const pool = parsePool(lire("poule-2027-h4-poule-b.html"));
const issy = parseTeamRoster(lire("equipe-2027-176169-aqissy.html"), "176169");
const kadi = parsePlayer(lire("joueur-2027-644801-fiche.html"), "644801");

const now = new Date("2026-10-18T20:00:00Z");
const H = 3_600_000;
const base = {
  standings: pool.standings,
  standingsAt: new Date("2026-10-18T10:00:00Z"),
  pool: { ties: pool.ties!, fetchedAt: new Date("2026-10-18T18:00:00Z") },
  roster: { players: issy.players, club: issy.club, captain: issy.captain, fetchedAt: new Date("2026-10-17T10:00:00Z") },
  now,
  poolFraisMs: 6 * H,
  rosterFraisMs: 7 * 24 * H,
};

describe("ficheEquipe — Squash in Issy, premier de la poule", () => {
  const f = ficheEquipe({ ...base, snTeamId: "176169" })!;

  it("situe l'équipe dans le classement", () => {
    expect(f.team).toMatchObject({ name: "Squash in Issy", code: "AQISSY", rank: 1, points: 6, played: 2, won: 2 });
  });

  it("ne garde que SES rencontres, dans l'ordre des journées : J1 1-3, J2 4-0, puis J3, J4 à venir", () => {
    expect(f.ties.slice(0, 4).map((t) => [t.round, t.homeCode, t.scoreHome, t.scoreAway, t.awayCode])).toEqual([
      ["J1", "VERR5", 1, 3, "AQISSY"],
      ["J2", "AQISSY", 4, 0, "VERR4"],
      ["J3", "VERR3", null, null, "AQISSY"],
      ["J4", "AQISSY", null, null, "CAL"],
    ]);
    expect(f.ties.every((t) => t.homeCode === "AQISSY" || t.awayCode === "AQISSY")).toBe(true);
  });

  it("nomme les deux équipes d'une rencontre à venir, d'après le classement", () => {
    const j3 = f.ties.find((t) => t.round === "J3")!;
    expect([j3.homeName, j3.awayName]).toEqual(["Verrieres 3", "Squash in Issy"]);
  });

  it("donne l'effectif, trié au rang mixte, avec la clé de chaque fiche joueur", () => {
    expect(f.roster?.map((p) => p.name)).toEqual([
      "RENARD NICOLAS",
      "MOREL STANISLAS",
      "MOREAU MICHAEL",
      "FERRY PETER",
      "KADI RAFIK",
      "MONNOIR MATHIEU",
    ]);
    expect(f.roster?.find((p) => p.name === "KADI RAFIK")?.regiid).toBe("644801");
    expect(f.team.club).toBeTruthy();
  });

  it("reprend un `regiid` absent (roster ancien) dans les rencontres de la poule, par le nom", () => {
    const ancien = issy.players.map(({ regiid: _r, ...p }) => p);
    const g = ficheEquipe({ ...base, snTeamId: "176169", roster: { ...base.roster, players: ancien } })!;
    expect(g.roster?.find((p) => p.name === "KADI RAFIK")?.regiid).toBe("644801");
    // Rien d'inventé : chaque `regiid` repris est bien celui que publie la fiche d'équipe.
    for (const p of g.roster ?? []) {
      expect([null, issy.players.find((x) => x.name === p.name)?.regiid]).toContain(p.regiid);
    }
  });

  it("à jour : rien à relire ; rencontres trop anciennes ou effectif absent : à relire", () => {
    expect(f.stale).toBe(false);
    const vieux = { ...base.pool, fetchedAt: new Date(now.getTime() - 7 * H) };
    expect(ficheEquipe({ ...base, snTeamId: "176169", pool: vieux })!.stale).toBe(true);
    expect(ficheEquipe({ ...base, snTeamId: "176169", roster: null })!.stale).toBe(true);
  });

  it("une équipe absente du classement n'a pas de fiche", () => {
    expect(ficheEquipe({ ...base, snTeamId: "999" })).toBeNull();
  });
});

describe("ficheJoueur — Rafik Kadi", () => {
  const input = { regiid: "644801", ties: pool.ties!, standings: pool.standings, now, fraisMs: 6 * H };

  it("sa fiche fédérale : deux matchs gagnés, l'équipe adverse retrouvée dans la poule", () => {
    const f = ficheJoueur({ ...input, cached: { player: kadi, fetchedAt: new Date("2026-10-18T19:00:00Z") } });
    expect(f).toMatchObject({ name: "KADI RAFIK", clt: "5B", source: "fiche", stale: false });
    expect(f.matches.map((m) => [m.date, m.opponent?.name, m.opponentTeam, m.ownTeam, m.result, m.score])).toEqual([
      ["2026-10-15", "BOUGARDIER FRANCK", "Verrieres 4", "Squash in Issy", "won", "11-8 11-6 11-5"],
      ["2026-10-08", "DETRY XAVIER", "Verrieres 5", "Squash in Issy", "won", "11-5 11-8 13-15 11-7"],
    ]);
  });

  it("sans fiche fédérale : les mêmes matchs, tirés de la poule et retournés de son point de vue", () => {
    const f = ficheJoueur({ ...input, cached: null });
    expect(f).toMatchObject({ name: "KADI RAFIK", source: "poule", stale: true });
    expect(f.matches.map((m) => [m.date, m.opponentTeam, m.result, m.score])).toEqual([
      ["2026-10-15", "Verrieres 4", "won", "11-8 11-6 11-5"],
      // Issy jouait à l'extérieur : la poule écrit « 5-11 8-11 15-13 7-11 », il le lit à l'endroit.
      ["2026-10-08", "Verrieres 5", "won", "11-5 11-8 13-15 11-7"],
    ]);
  });

  it("une fiche de plus de six heures est à relire", () => {
    const f = ficheJoueur({ ...input, cached: { player: kadi, fetchedAt: new Date(now.getTime() - 7 * H) } });
    expect(f.stale).toBe(true);
  });
});
