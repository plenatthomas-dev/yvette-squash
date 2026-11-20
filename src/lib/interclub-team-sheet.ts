// LA FICHE D'UNE ÉQUIPE DE LA POULE, ET CELLE D'UN JOUEUR — ce que l'écran en reçoit. Pur.
//
// Toucher une équipe du classement ouvre ses rencontres (lues dans le fragment de poule, cf.
// `squashnet/pool.ts`), le détail de chacune et son effectif (la fiche d'équipe fédérale, cf.
// `squashnet/roster.ts`) ; toucher un joueur ouvre ses matchs (sa fiche fédérale, cf.
// `squashnet/player.ts`, ou à défaut ce que la poule en dit).
//
// Ce module ASSEMBLE, il ne lit rien : la base et le réseau sont dans `interclub-team-sheet-db.ts`.
// L'écran n'importe que des types d'ici.

import { inverserScore, jeuxDuScore } from "./interclub-score";
import { nameKey, type RosterPlayer } from "./squashnet/roster";
import type { PoolTie } from "./squashnet/pool";
import { otherTeamInLabel, splitTieLabel, type PlayerHistory, type PlayerMatch } from "./squashnet/player";
import type { StandingRow } from "./squashnet/standings";
import type { TieLine, TiePlayer, TieSheet } from "./squashnet/tie";

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

/**
 * Un match de la fiche d'un joueur, avec les équipes quand on sait les nommer.
 *
 * `clt`, `rang`, `rangM` : SON classement CE SOIR-LÀ, lu sur la rencontre de nos poules ou, pour
 * un joueur du club, dans son historique mensuel — null sinon (cf. `ficheJoueur`). La fiche
 * fédérale répète son classement ACTUEL sur chaque ligne (mesuré le
 * 2026-10-18 : 4D partout pour Plenat, classé 5A le 4 juin sur la feuille de poule) ; l'afficher
 * par match ferait croire à un classement figé. Celui de l'adversaire, lui, est bien daté.
 */
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
  /** Les équipes pour lesquelles il a joué, la plus récente d'abord — presque toujours une seule. */
  teams: string[];
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

// ---------------------------------------------------------------------------
//  Les simples SANS JOUEURS, complétés par les fiches des joueurs.
// ---------------------------------------------------------------------------

/**
 * Un simple dont la poule publie le score mais pas les joueurs.
 *
 * Mesuré le 2026-11-20 sur la poule B des Hommes 4 : 20 simples sur 60. La ligue y laisse les
 * deux cases VIDES — et la feuille de match publique de la rencontre est vide elle aussi. La
 * FICHE DE CHAQUE JOUEUR, elle, porte bien le match : date, adversaire, score.
 */
export function ligneSansJoueurs(l: PoolTie["lines"][number]): boolean {
  return !l.home && !l.away && !!(l.score ?? "").trim();
}

/** Une rencontre a-t-elle au moins un simple à compléter ? */
export function rencontreACompleter(t: PoolTie): boolean {
  return t.lines.some(ligneSansJoueurs);
}

/** Le score sous une forme comparable : jeux normalisés, sinon le texte compacté. */
function cleScore(score: string | null | undefined): string {
  const jeux = jeuxDuScore(score);
  return jeux ? jeux.map(([a, b]) => `${a}-${b}`).join(" ") : (score ?? "").trim().replace(/\s+/g, " ");
}

/** La fiche d'un joueur, et le sigle de l'équipe dans laquelle il est inscrit. */
export interface FicheParEquipe {
  code: string;
  player: PlayerHistory;
}

/**
 * Remplit les simples sans joueurs à partir des fiches joueurs. PUR, testé.
 *
 * Pour chaque fiche d'un joueur inscrit chez le receveur (ou le visiteur), le match joué À LA
 * DATE de la rencontre est rapproché du simple qui porte LE MÊME SCORE, vu du bon côté. On ne
 * devine rien : pas de date, pas de score lisible des deux côtés, ou aucun simple qui
 * corresponde — et la case reste vide. Deux simples au score identique prennent les joueurs dans
 * l'ordre des fiches : l'erreur possible se limite à échanger deux simples de même score.
 */
export function completerParFiches(ties: readonly PoolTie[], fiches: readonly FicheParEquipe[]): PoolTie[] {
  return ties.map((t) => {
    if (!t.date || !rencontreACompleter(t)) return t;
    const lines = t.lines.map((l) => ({ ...l }));
    for (const side of ["home", "away"] as const) {
      const code = side === "home" ? t.homeCode : t.awayCode;
      for (const f of fiches) {
        if (f.code !== code || !f.player.name) continue;
        for (const m of f.player.matches) {
          if (m.date !== t.date || !m.score) continue;
          // La fiche écrit le score de SON côté. La poule, sur ces simples-là, ne l'écrit PAS
          // toujours du côté du receveur (mesuré : souvent du côté du perdant). On rapproche donc
          // dans les deux sens, et on réécrit le score du côté du receveur, comme partout ailleurs.
          const lisible = jeuxDuScore(m.score) !== null;
          // Un score illisible (« … 5-5 Ab ») ne se retourne pas : on ne le rapproche que tel quel.
          if (side === "away" && !lisible) continue;
          const vu = side === "home" ? m.score : inverserScore(m.score);
          const droit = cleScore(vu);
          const envers = lisible ? cleScore(inverserScore(vu)) : null;
          const libres = lines.filter((x) => !x.home && !x.away && (x.score ?? "").trim());
          const l =
            libres.find((x) => cleScore(x.score) === droit) ??
            (envers ? libres.find((x) => cleScore(x.score) === envers) : undefined);
          if (!l) continue;
          l.score = vu;
          const moi = {
            name: f.player.name,
            regiid: f.player.regiid,
            clt: f.player.clt,
            rang: f.player.rang,
            rangM: f.player.rangM,
          };
          const lui = m.opponent;
          if (side === "home") {
            l.home = moi;
            l.away = lui;
          } else {
            l.away = moi;
            l.home = lui;
          }
          if (m.result) l.winner = (m.result === "won") === (side === "home") ? "home" : "away";
        }
      }
    }
    return { ...t, lines };
  });
}

/** Préfixe de `TieSheet.snTieId` d'une feuille RECONSTITUÉE (cf. `feuilleDepuisPoule`). */
export const FEUILLE_POULE = "poule:";

/**
 * Une rencontre de poule, COMPLÈTE, mise au format d'une feuille de match. PUR, testé.
 *
 * Le repli quand la feuille officielle publique est VIDE alors que la poule publie les scores
 * (mesuré le 2026-11-20 sur Verrières 3 – Yvette 1 : scores publiés, 1-3, feuille vide, joueurs
 * absents). Une fois les joueurs complétés par leurs fiches (`completerParFiches`), la rencontre
 * de poule dit tout ce que dirait la feuille : la feuille reconstituée nourrit alors l'import dans
 * l'appli et le palmarès, exactement comme l'officielle.
 *
 * Null — on ne reconstitue rien — si un simple manque un joueur ou un vainqueur, si notre sigle
 * n'est pas d'un des deux côtés (ou des deux : on ne saurait pas lequel), ou si le décompte des
 * simples ne redonne pas le total publié par la ligue.
 */
export function feuilleDepuisPoule(
  t: PoolTie,
  ourCode: string | null,
): { sheet: TieSheet; side: "A" | "B" } | null {
  if (!ourCode || t.homeCode === t.awayCode || t.lines.length === 0) return null;
  const side = ourCode === t.homeCode ? "A" : ourCode === t.awayCode ? "B" : null;
  if (!side) return null;
  if (!t.lines.every((l) => l.home && l.away && l.winner)) return null;
  const gagnesA = t.lines.filter((l) => l.winner === "home").length;
  if (t.scoreHome !== null && t.scoreAway !== null) {
    if (gagnesA !== t.scoreHome || t.lines.length - gagnesA !== t.scoreAway) return null;
  }
  const lines: TieLine[] = t.lines.map((l) => {
    const jeux = jeuxDuScore(l.score);
    return {
      label: l.label,
      a: l.home,
      b: l.away,
      score: l.score,
      winner: l.winner === "home" ? "A" : "B",
      gamesA: jeux ? jeux.filter(([a, b]) => a > b).length : null,
      gamesB: jeux ? jeux.filter(([a, b]) => b > a).length : null,
      pointsA: jeux ? jeux.reduce((n, [a]) => n + a, 0) : null,
      pointsB: jeux ? jeux.reduce((n, [, b]) => n + b, 0) : null,
    };
  });
  return {
    side,
    sheet: {
      snTieId: `${FEUILLE_POULE}${t.round}:${t.date ?? ""}`,
      codeA: t.homeCode,
      codeB: t.awayCode,
      division: null,
      group: null,
      round: t.round,
      venue: null,
      date: t.date,
      time: t.time,
      lines,
      totals: {
        matchesA: gagnesA,
        matchesB: t.lines.length - gagnesA,
        gamesA: null,
        gamesB: null,
        pointsA: null,
        pointsB: null,
      },
    },
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

/** Un relevé mensuel du classement d'un joueur du club (`SquashnetRankingPoint`). */
export interface ClassementMensuel {
  /** La période fédérale, « YYYY-MM-DD » : le jour de publication. */
  month: string;
  clt: string;
  rang: number | null;
  rangM: number | null;
}

/**
 * Le classement EN VIGUEUR un jour donné : le dernier publié ce jour-là ou avant.
 *
 * Jamais un relevé postérieur : un match de septembre ne se lit pas au classement d'octobre. Et
 * rien si l'historique commence après le match — un trou dit « on ne sait pas ».
 */
export function classementAu(
  historique: readonly ClassementMensuel[],
  date: string | null,
): ClassementMensuel | null {
  if (!date) return null;
  let vu: ClassementMensuel | null = null;
  for (const p of historique) {
    if (p.month <= date && (!vu || p.month > vu.month)) vu = p;
  }
  return vu;
}

/**
 * La fiche d'un joueur : sa fiche fédérale si on l'a, sinon ce que nos poules en disent.
 *
 * LES ÉQUIPES D'UN MATCH DE LA FICHE se retrouvent dans la poule par le COUPLE de `regiid` et la
 * date — c'est exact. À défaut (un match joué hors de nos poules), on coupe l'intitulé sur deux
 * noms connus (`splitTieLabel`) et on reconnaît son équipe parmi celles où on l'a déjà vu jouer ;
 * sinon sur cette seule équipe, l'autre nom pris tel quel (`otherTeamInLabel`).
 *
 * SON CLASSEMENT DU SOIR : celui de la feuille de poule quand le match y est (ce que la ligue a
 * noté ce soir-là) ; sinon, pour un joueur du CLUB, celui de son historique mensuel en vigueur à
 * la date du match (`history`, rapproché par la licence) ; sinon rien.
 */
export function ficheJoueur(input: {
  regiid: string;
  cached: { player: PlayerHistory; fetchedAt: Date } | null;
  ties: readonly PoolTie[];
  standings: readonly StandingRow[];
  /** Son historique mensuel s'il est du club ; null sinon. */
  history?: readonly ClassementMensuel[] | null;
  now: Date;
  fraisMs: number;
}): PlayerSheet {
  const noms = nomsParSigle(input.standings);
  const occ = occurrences(input.regiid, input.ties);
  const depuisPoule = matchsDepuisPoule(occ, noms);
  const parDate = (a: { date: string | null }, b: { date: string | null }) =>
    (b.date ?? "").localeCompare(a.date ?? "");

  const equipes = (ms: readonly PlayerSheetMatch[]) => [
    ...new Set(ms.map((m) => m.ownTeam).filter((v): v is string => !!v)),
  ];

  const p = input.cached?.player ?? null;
  if (!p) {
    const lui = occ[0] ? (occ[0].side === "home" ? occ[0].line.home : occ[0].line.away) : null;
    const tries = depuisPoule.sort(parDate);
    // Faute de fiche, l'en-tête prend son classement le plus récent qu'on ait lu.
    const dernier = tries[0] ?? lui;
    return {
      regiid: input.regiid,
      name: lui?.name ?? null,
      clt: dernier?.clt ?? null,
      rang: dernier?.rang ?? null,
      rangM: dernier?.rangM ?? null,
      category: null,
      teams: equipes(tries),
      matches: tries,
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
    // Son classement de CE SOIR-LÀ (cf. `PlayerSheetMatch`) : la feuille de poule d'abord, son
    // historique mensuel ensuite — jamais celui que la fiche répète.
    const lui = o ? (o.side === "home" ? o.line.home : o.line.away) : null;
    const soir = lui?.clt ? lui : classementAu(input.history ?? [], m.date);
    const duSoir = { ...m, clt: soir?.clt ?? null, rang: soir?.rang ?? null, rangM: soir?.rangM ?? null };
    if (o) {
      const home = nomDe(o.tie.homeCode, o.tie.homeName, noms);
      const away = nomDe(o.tie.awayCode, o.tie.awayName, noms);
      return { ...duSoir, ownTeam: o.side === "home" ? home : away, opponentTeam: o.side === "home" ? away : home };
    }
    const coupe = splitTieLabel(m.tie, tousLesNoms);
    if (coupe) {
      const [a, b] = coupe;
      if (sesEquipes.has(a) && !sesEquipes.has(b)) return { ...duSoir, ownTeam: a, opponentTeam: b };
      if (sesEquipes.has(b) && !sesEquipes.has(a)) return { ...duSoir, ownTeam: b, opponentTeam: a };
    }
    // L'autre nom est inconnu : on coupe sur SON équipe, si une seule colle.
    const parSonEquipe = [...sesEquipes].flatMap((e) => {
      const autre = otherTeamInLabel(m.tie, e);
      return autre ? [{ ownTeam: e, opponentTeam: autre }] : [];
    });
    if (parSonEquipe.length === 1) return { ...duSoir, ...parSonEquipe[0] };
    return { ...duSoir, ownTeam: null, opponentTeam: null };
  });
  matches.sort(parDate);

  return {
    regiid: input.regiid,
    name: p.name,
    clt: p.clt,
    rang: p.rang,
    rangM: p.rangM,
    category: p.category,
    teams: equipes(matches),
    matches,
    source: "fiche",
    fetchedAt: input.cached!.fetchedAt.toISOString(),
    stale: input.now.getTime() - input.cached!.fetchedAt.getTime() > input.fraisMs,
  };
}
