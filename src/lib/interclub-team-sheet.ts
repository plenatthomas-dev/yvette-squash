// LA FICHE D'UNE ÉQUIPE DE LA POULE, ET CELLE D'UN JOUEUR — ce que l'écran en reçoit. Pur.
//
// Toucher une équipe du classement ouvre ses rencontres (lues dans le fragment de poule, cf.
// `squashnet/pool.ts`), le détail de chacune et son effectif (la fiche d'équipe fédérale, cf.
// `squashnet/roster.ts`) ; toucher un joueur ouvre ses matchs (sa fiche fédérale, cf.
// `squashnet/player.ts`, ou à défaut ce que la poule en dit).
//
// Ce module ASSEMBLE, il ne lit rien : la base et le réseau sont dans `interclub-team-sheet-db.ts`.
// L'écran n'importe que des types d'ici.

import { inverserScore } from "./interclub-score";
import { nameKey, type RosterPlayer } from "./squashnet/roster";
import type { PoolTie } from "./squashnet/pool";
import { otherTeamInLabel, splitTieLabel, type PlayerHistory, type PlayerMatch } from "./squashnet/player";
import type { StandingRow } from "./squashnet/standings";
import type { TiePlayer } from "./squashnet/tie";

/** Une équipe de la poule, telle que l'écran la nomme et la rejoint. */
export interface SheetTeamRef {
  snTeamId: string | null;
  code: string | null;
  name: string;
  rank: number;
}

/** La fiche d'une équipe. */
export interface TeamSheet {
  team: SheetTeamRef & {
    points: number;
    played: number;
    won: number;
    drawWon: number;
    drawLost: number;
    lost: number;
    club: string | null;
    captain: string | null;
  };
  /** Toutes les équipes de la poule : de quoi nommer un sigle, et rejoindre l'adversaire. */
  teams: SheetTeamRef[];
  /** SES rencontres, dans l'ordre des journées. */
  ties: PoolTie[];
  /** Dernière lecture des rencontres, ISO — null si on ne les a jamais lues. */
  poolAt: string | null;
  standingsAt: string | null;
  /** Ses inscrits, du mieux au moins bien classé ; null si on n'a pas encore sa fiche. */
  roster: RosterPlayer[] | null;
  rosterAt: string | null;
  /** Vrai = une relecture vaut la peine (rencontres ou effectif trop anciens, ou absents). */
  stale: boolean;
}

/** Un match de la fiche d'un joueur, avec les équipes quand on sait les nommer. */
export interface PlayerSheetMatch extends PlayerMatch {
  /** L'équipe pour laquelle il jouait ce soir-là. */
  ownTeam: string | null;
  /** L'équipe de son adversaire. */
  opponentTeam: string | null;
}

/** La fiche d'un joueur. */
export interface PlayerSheet {
  regiid: string;
  name: string | null;
  clt: string | null;
  rang: number | null;
  rangM: number | null;
  category: string | null;
  /** Du plus récent au plus ancien. */
  matches: PlayerSheetMatch[];
  /**
   * `fiche` : sa fiche fédérale, tous ses matchs de l'épreuve. `poule` : à défaut (pas encore
   * lue, ou la ligue n'a pas répondu), ses matchs dans NOS poules, tirés des rencontres — justes,
   * mais peut-être incomplets s'il a joué ailleurs. L'écran le dit.
   */
  source: "fiche" | "poule";
  fetchedAt: string | null;
  stale: boolean;
}

/** Les numéros de journée se trient en nombres : « J10 » vient après « J9 ». */
const journee = (round: string) => Number.parseInt(/(\d+)/.exec(round)?.[1] ?? "0", 10);

/** Le sigle → le nom de l'équipe, d'après le classement. */
export function nomsParSigle(standings: readonly StandingRow[]): Map<string, string> {
  return new Map(standings.filter((r) => r.code).map((r) => [r.code as string, r.name]));
}

/** Le nom complet d'un côté : celui du total publié, sinon celui du classement, sinon le sigle. */
function nomDe(code: string, publie: string | null, noms: ReadonlyMap<string, string>): string {
  return publie ?? noms.get(code) ?? code;
}

/**
 * La fiche d'une équipe, assemblée depuis ce qu'on a en base.
 *
 * Le `regiid` d'un inscrit manque sur les rosters rangés avant ce champ : on le reprend alors
 * dans les rencontres de la poule, par le nom (`nameKey`, ordre des mots indifférent) — et
 * seulement si UN SEUL `regiid` y correspond.
 */
export function ficheEquipe(input: {
  snTeamId: string;
  standings: readonly StandingRow[];
  standingsAt: Date | null;
  pool: { ties: readonly PoolTie[]; fetchedAt: Date } | null;
  roster: { players: readonly RosterPlayer[]; club: string | null; captain: string | null; fetchedAt: Date } | null;
  now: Date;
  poolFraisMs: number;
  rosterFraisMs: number;
}): TeamSheet | null {
  const row = input.standings.find((r) => r.snTeamId === input.snTeamId);
  if (!row) return null;
  const noms = nomsParSigle(input.standings);

  const ties = (input.pool?.ties ?? [])
    .filter((t) => row.code !== null && (t.homeCode === row.code || t.awayCode === row.code))
    .map((t) => ({
      ...t,
      homeName: nomDe(t.homeCode, t.homeName, noms),
      awayName: nomDe(t.awayCode, t.awayName, noms),
    }))
    .sort((a, b) => journee(a.round) - journee(b.round) || (a.date ?? "").localeCompare(b.date ?? ""));

  let roster: RosterPlayer[] | null = null;
  if (input.roster) {
    const parNom = new Map<string, string | null>();
    for (const t of input.pool?.ties ?? []) {
      for (const l of t.lines) {
        for (const p of [l.home, l.away]) {
          if (!p?.regiid) continue;
          const k = nameKey(p.name);
          const deja = parNom.get(k);
          parNom.set(k, deja === undefined || deja === p.regiid ? p.regiid : null);
        }
      }
    }
    roster = input.roster.players
      .map((p) => (p.regiid ? p : { ...p, regiid: parNom.get(nameKey(p.name)) ?? null }))
      // Du mieux au moins bien classé, au rang MIXTE — celui de l'ordre des simples. Un joueur
      // sans rang (absent du classement) passe en dernier, jamais en tête.
      .sort((a, b) => (a.rangM ?? Infinity) - (b.rangM ?? Infinity) || a.name.localeCompare(b.name, "fr"));
  }

  const t = input.now.getTime();
  const stale =
    !input.pool ||
    t - input.pool.fetchedAt.getTime() > input.poolFraisMs ||
    !input.roster ||
    t - input.roster.fetchedAt.getTime() > input.rosterFraisMs;

  return {
    team: {
      snTeamId: row.snTeamId,
      code: row.code,
      name: row.name,
      rank: row.rank,
      points: row.points,
      played: row.played,
      won: row.won,
      drawWon: row.drawWon,
      drawLost: row.drawLost,
      lost: row.lost,
      club: input.roster?.club ?? null,
      captain: input.roster?.captain ?? null,
    },
    teams: input.standings.map((r) => ({ snTeamId: r.snTeamId, code: r.code, name: r.name, rank: r.rank })),
    ties,
    poolAt: input.pool?.fetchedAt.toISOString() ?? null,
    standingsAt: input.standingsAt?.toISOString() ?? null,
    roster,
    rosterAt: input.roster?.fetchedAt.toISOString() ?? null,
    stale,
  };
}

/** Où ce joueur figure dans une rencontre de poule : le simple, son côté. */
interface Occurrence {
  tie: PoolTie;
  line: PoolTie["lines"][number];
  side: "home" | "away";
}

function occurrences(regiid: string, ties: readonly PoolTie[]): Occurrence[] {
  const out: Occurrence[] = [];
  for (const tie of ties) {
    for (const line of tie.lines) {
      if (line.home?.regiid === regiid) out.push({ tie, line, side: "home" });
      else if (line.away?.regiid === regiid) out.push({ tie, line, side: "away" });
    }
  }
  return out;
}

/** Ses matchs JOUÉS dans nos poules, tirés des rencontres, de SON point de vue. */
function matchsDepuisPoule(occ: readonly Occurrence[], noms: ReadonlyMap<string, string>): PlayerSheetMatch[] {
  return occ
    .filter((o) => o.line.winner !== null)
    .map(({ tie, line, side }) => {
      const lui = side === "home" ? line.home : line.away;
      const adv: TiePlayer | null = side === "home" ? line.away : line.home;
      const home = nomDe(tie.homeCode, tie.homeName, noms);
      const away = nomDe(tie.awayCode, tie.awayName, noms);
      return {
        tie: `${home} – ${away}`,
        date: tie.date,
        time: tie.time,
        clt: lui?.clt ?? null,
        rang: lui?.rang ?? null,
        rangM: lui?.rangM ?? null,
        opponent: adv,
        result: line.winner === side ? ("won" as const) : ("lost" as const),
        score: line.score && side === "away" ? inverserScore(line.score) : line.score,
        ownTeam: side === "home" ? home : away,
        opponentTeam: side === "home" ? away : home,
      };
    });
}

/**
 * La fiche d'un joueur : sa fiche fédérale si on l'a, sinon ce que nos poules en disent.
 *
 * LES ÉQUIPES D'UN MATCH DE LA FICHE se retrouvent dans la poule par le COUPLE de `regiid` et la
 * date — c'est exact. À défaut (un match joué hors de nos poules), on coupe l'intitulé sur deux
 * noms connus (`splitTieLabel`) et on reconnaît son équipe parmi celles où on l'a déjà vu jouer ;
 * sinon sur cette seule équipe, l'autre nom pris tel quel (`otherTeamInLabel`).
 */
export function ficheJoueur(input: {
  regiid: string;
  cached: { player: PlayerHistory; fetchedAt: Date } | null;
  ties: readonly PoolTie[];
  standings: readonly StandingRow[];
  now: Date;
  fraisMs: number;
}): PlayerSheet {
  const noms = nomsParSigle(input.standings);
  const occ = occurrences(input.regiid, input.ties);
  const depuisPoule = matchsDepuisPoule(occ, noms);
  const parDate = (a: { date: string | null }, b: { date: string | null }) =>
    (b.date ?? "").localeCompare(a.date ?? "");

  const p = input.cached?.player ?? null;
  if (!p) {
    const lui = occ[0] ? (occ[0].side === "home" ? occ[0].line.home : occ[0].line.away) : null;
    return {
      regiid: input.regiid,
      name: lui?.name ?? null,
      clt: lui?.clt ?? null,
      rang: lui?.rang ?? null,
      rangM: lui?.rangM ?? null,
      category: null,
      matches: depuisPoule.sort(parDate),
      source: "poule",
      fetchedAt: null,
      stale: true,
    };
  }

  const sesEquipes = new Set(depuisPoule.map((m) => m.ownTeam).filter((v): v is string => !!v));
  const tousLesNoms = [...new Set([...noms.values(), ...input.ties.flatMap((t) => [t.homeName ?? "", t.awayName ?? ""])])].filter(Boolean);

  const matches = p.matches.map((m): PlayerSheetMatch => {
    const o = occ.find(
      (x) =>
        x.tie.date === m.date &&
        (x.side === "home" ? x.line.away : x.line.home)?.regiid === m.opponent?.regiid,
    );
    if (o) {
      const home = nomDe(o.tie.homeCode, o.tie.homeName, noms);
      const away = nomDe(o.tie.awayCode, o.tie.awayName, noms);
      return { ...m, ownTeam: o.side === "home" ? home : away, opponentTeam: o.side === "home" ? away : home };
    }
    const coupe = splitTieLabel(m.tie, tousLesNoms);
    if (coupe) {
      const [a, b] = coupe;
      if (sesEquipes.has(a) && !sesEquipes.has(b)) return { ...m, ownTeam: a, opponentTeam: b };
      if (sesEquipes.has(b) && !sesEquipes.has(a)) return { ...m, ownTeam: b, opponentTeam: a };
    }
    // Hors de nos poules, l'autre nom est inconnu : on coupe sur SON équipe, si une seule colle.
    const parSonEquipe = [...sesEquipes].flatMap((e) => {
      const autre = otherTeamInLabel(m.tie, e);
      return autre ? [{ ownTeam: e, opponentTeam: autre }] : [];
    });
    if (parSonEquipe.length === 1) return { ...m, ...parSonEquipe[0] };
    return { ...m, ownTeam: null, opponentTeam: null };
  });

  return {
    regiid: input.regiid,
    name: p.name,
    clt: p.clt,
    rang: p.rang,
    rangM: p.rangM,
    category: p.category,
    matches: matches.sort(parDate),
    source: "fiche",
    fetchedAt: input.cached!.fetchedAt.toISOString(),
    stale: input.now.getTime() - input.cached!.fetchedAt.getTime() > input.fraisMs,
  };
}
