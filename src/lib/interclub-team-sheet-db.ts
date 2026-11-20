// LA FICHE D'UNE ÉQUIPE DE LA POULE, ET CELLE D'UN JOUEUR — côté base et réseau.
//
// Le pendant IMPUR d'`interclub-team-sheet.ts`. Deux gestes par fiche, sur le patron de
// `opponents` : LIRE ce qu'on a (aucune requête fédérale), et RAFRAÎCHIR ce qui est trop ancien
// (au plus une requête par source, bornée par la fraîcheur et par un repos après échec).
//
// ⚠️ ON NE SERT PAS DE RELAIS VERS SQUASHNET. Les identifiants viennent du client (une équipe
// touchée dans le classement, un joueur touché dans une rencontre) : ils ne sont suivis que s'ils
// figurent DÉJÀ dans nos données — l'équipe dans le classement d'une de nos poules, le joueur
// dans ses rencontres ou dans un effectif rangé. Un identifiant inventé rend 404, sans requête.

import { prisma } from "./db";
import { loadPlayer, loadPlayers, loadPool, storePlayer } from "./interclub-pool-db";
import { DELAI_MS, ECHEC_REPOS_MS, ROSTER_FRAIS_JOURS, loadRosters, refreshRosters } from "./interclub-roster-db";
import { refreshTeamStandings, type StandingsAnchor } from "./interclub-standings";
import {
  completerParFiches,
  ficheEquipe,
  ficheJoueur,
  rencontreACompleter,
  type FicheParEquipe,
  type ClassementMensuel,
  type PlayerSheet,
  type TeamSheet,
} from "./interclub-team-sheet";
import { fetchPlayer } from "./squashnet/player";
import type { PoolTie } from "./squashnet/pool";
import { estLigneClassement, type StandingRow } from "./squashnet/standings";

/**
 * Au-delà de quel âge relit-on les rencontres d'une poule, à l'ouverture d'une fiche ?
 *
 * SIX HEURES. Le cron les relit déjà toutes les 4 h après chacun de nos matchs, et le lundi ; ce
 * geste-ci rattrape le reste — une rencontre entre deux autres clubs, saisie un mardi. Une
 * requête par poule et par demi-journée au plus reste invisible chez la ligue.
 */
export const POULE_FRAIS_MS = 6 * 3_600_000;

/** Même raisonnement pour la fiche d'un joueur : ses matchs ne bougent qu'un soir de rencontre. */
export const JOUEUR_FRAIS_MS = 6 * 3_600_000;

const ROSTER_FRAIS_MS = ROSTER_FRAIS_JOURS * 86_400_000;

/** Dernier échec par poule et par joueur — cf. `ECHEC_REPOS_MS` (mémoire de process, assumée). */
const echecsPoule = new Map<string, number>();
const echecsJoueur = new Map<string, number>();

/** Pour les tests : une carte de process survivrait d'un cas au suivant. */
export function oublierEchecsFiches(): void {
  echecsPoule.clear();
  echecsJoueur.clear();
}

/** Une de nos poules : son ancrage complet et son classement le plus récent. */
interface PouleAncree {
  anchor: StandingsAnchor;
  standings: StandingRow[];
  standingsAt: Date | null;
}

/**
 * Nos poules ancrées, UNE PAR `roundid`. Deux équipes du club dans la même poule rapportent le
 * même classement : on garde le relevé le plus récent (même règle que l'écran, `poulesAffichees`).
 */
async function nosPoules(): Promise<PouleAncree[]> {
  const equipes = await prisma.interclubTeam.findMany({
    where: {
      snEventId: { not: null },
      snDrawId: { not: null },
      snRoundId: { not: null },
      snStandingsJson: { not: null },
    },
    select: { id: true, snEventId: true, snDrawId: true, snRoundId: true, snStandingsJson: true, snStandingsAt: true },
  });
  const parPoule = new Map<string, PouleAncree>();
  for (const e of equipes) {
    let standings: StandingRow[] = [];
    try {
      const v: unknown = JSON.parse(e.snStandingsJson as string);
      if (Array.isArray(v) && v.every(estLigneClassement)) standings = v as StandingRow[];
    } catch {
      /* illisible : ignoré, comme sur l'écran */
    }
    if (standings.length === 0) continue;
    const roundId = e.snRoundId as string;
    const deja = parPoule.get(roundId);
    if (deja && (deja.standingsAt?.getTime() ?? 0) >= (e.snStandingsAt?.getTime() ?? 0)) continue;
    parPoule.set(roundId, {
      anchor: { id: e.id, snEventId: e.snEventId as string, snDrawId: e.snDrawId as string, snRoundId: roundId },
      standings,
      standingsAt: e.snStandingsAt,
    });
  }
  return [...parPoule.values()];
}

/** L'identifiant fédéral a-t-il la forme d'un identifiant ? (Des chiffres, rien d'autre.) */
export const estIdentifiant = (v: string | null): v is string => !!v && /^\d{1,12}$/.test(v);

async function pouleDe(snTeamId: string): Promise<PouleAncree | null> {
  return (await nosPoules()).find((p) => p.standings.some((r) => r.snTeamId === snTeamId)) ?? null;
}

/**
 * Au plus combien de fiches joueurs relire d'un coup pour compléter des simples sans joueurs :
 * un effectif de poule tient en une dizaine, espacées de `DELAI_MS`.
 */
export const MAX_FICHES_COMPLETION = 12;

/** La fiche d'une équipe, depuis la base seule. Null : équipe absente de nos poules. */
export async function ficheEquipeEnBase(snTeamId: string, now: Date = new Date()): Promise<TeamSheet | null> {
  return (await assembler(snTeamId, now))?.sheet ?? null;
}

/**
 * La fiche assemblée, et les fiches joueurs qu'il faudrait relire pour compléter les simples
 * que la poule publie sans joueurs (cf. `ligneSansJoueurs`).
 */
async function assembler(
  snTeamId: string,
  now: Date,
): Promise<{ sheet: TeamSheet | null; aRelire: string[] } | null> {
  const poule = await pouleDe(snTeamId);
  if (!poule) return null;
  const [pool, rosters, ligne] = await Promise.all([
    loadPool(poule.anchor.snRoundId),
    loadRosters([snTeamId]),
    prisma.squashnetTeamRoster.findUnique({ where: { snTeamId }, select: { fetchedAt: true } }),
  ]);
  const r = rosters.get(snTeamId);
  const sheet = ficheEquipe({
    snTeamId,
    standings: poule.standings,
    standingsAt: poule.standingsAt,
    pool,
    roster: r && ligne ? { players: r.players, club: r.club, captain: r.captain, fetchedAt: ligne.fetchedAt } : null,
    now,
    poolFraisMs: POULE_FRAIS_MS,
    rosterFraisMs: ROSTER_FRAIS_MS,
  });
  if (!sheet || !sheet.ties.some(rencontreACompleter)) return { sheet, aRelire: [] };

  // LES SIMPLES SANS JOUEURS : complétés par les fiches déjà rangées des joueurs des deux
  // équipes. Une lecture de base, aucune requête fédérale.
  const codeVersId = new Map(
    poule.standings.filter((x) => x.code && x.snTeamId).map((x) => [x.code as string, x.snTeamId as string]),
  );
  const codes = [...new Set(sheet.ties.filter(rencontreACompleter).flatMap((t) => [t.homeCode, t.awayCode]))];
  const ids = codes.map((c) => codeVersId.get(c)).filter((v): v is string => !!v);
  const effectifs = await loadRosters(ids);
  const inscrits: { code: string; regiid: string }[] = [];
  for (const code of codes) {
    const id = codeVersId.get(code);
    // Notre propre effectif a reçu ses `regiid` manquants dans `ficheEquipe` : on le préfère.
    const joueurs = id === snTeamId && sheet.roster ? sheet.roster : (id ? effectifs.get(id)?.players : null) ?? [];
    for (const p of joueurs) if (p.regiid) inscrits.push({ code, regiid: p.regiid });
  }
  const rangees = await loadPlayers(inscrits.map((i) => i.regiid));
  const fiches: FicheParEquipe[] = inscrits.flatMap((i) => {
    const f = rangees.get(i.regiid);
    return f ? [{ code: i.code, player: f.player }] : [];
  });
  const ties = completerParFiches(sheet.ties, fiches);

  // Ce qui reste incomplet : les fiches de NOS inscrits (l'équipe ouverte) absentes, ou relues
  // avant la rencontre, valent une relecture. Une fiche relue APRÈS et qui ne porte pas le
  // match ne se relit plus : la ligue n'a rien de plus à dire.
  const restantes = ties.filter(rencontreACompleter);
  const derniere = restantes.reduce((d, t) => ((t.date ?? "") > d ? (t.date as string) : d), "");
  const aRelire = derniere
    ? inscrits
        .filter((i) => i.code === sheet.team.code)
        .map((i) => i.regiid)
        .filter((regiid) => {
          const f = rangees.get(regiid);
          if (f && f.fetchedAt.toISOString().slice(0, 10) >= derniere) return false;
          const echec = echecsJoueur.get(regiid);
          return echec === undefined || now.getTime() - echec >= ECHEC_REPOS_MS;
        })
    : [];
  return { sheet: { ...sheet, ties, stale: sheet.stale || aRelire.length > 0 }, aRelire };
}

/**
 * Relit ce qui est trop ancien — les rencontres de la poule, l'effectif de l'équipe —, puis rend
 * la fiche. Au plus DEUX requêtes fédérales, espacées ; souvent aucune.
 *
 * Les rencontres se relisent par `refreshTeamStandings` : c'est le même fragment que le
 * classement, qui se trouve donc rafraîchi au passage.
 */
export async function ficheEquipeRafraichie(snTeamId: string, now: Date = new Date()): Promise<TeamSheet | null> {
  const poule = await pouleDe(snTeamId);
  if (!poule) return null;
  const roundId = poule.anchor.snRoundId;

  const pool = await loadPool(roundId);
  const echec = echecsPoule.get(roundId);
  let requete = false;
  if (
    (!pool || now.getTime() - pool.fetchedAt.getTime() > POULE_FRAIS_MS) &&
    (echec === undefined || now.getTime() - echec >= ECHEC_REPOS_MS)
  ) {
    requete = true;
    const r = await refreshTeamStandings(poule.anchor);
    // Une poule relue mais dont les rencontres ne se rangent pas compte comme un échec : sans
    // cela, chaque ouverture repartirait chez la ligue pour le même résultat.
    if (r.ok && r.ties === "stored") echecsPoule.delete(roundId);
    else echecsPoule.set(roundId, now.getTime());
  }

  // L'espacement précède l'appel suivant, jamais après le dernier (cf. `refreshRosters`).
  if (requete) await new Promise((res) => setTimeout(res, DELAI_MS));
  await refreshRosters([snTeamId], { now });

  // Les simples publiés sans joueurs : on relit les fiches de nos inscrits qui peuvent les dire.
  const avant = await assembler(snTeamId, now);
  for (const [i, regiid] of (avant?.aRelire ?? []).slice(0, MAX_FICHES_COMPLETION).entries()) {
    if (i > 0) await new Promise((res) => setTimeout(res, DELAI_MS));
    try {
      await storePlayer(await fetchPlayer(regiid), now);
      echecsJoueur.delete(regiid);
    } catch (e) {
      console.warn("[interclub-team-sheet] fiche joueur non relue", regiid, e);
      echecsJoueur.set(regiid, now.getTime());
    }
  }

  return ficheEquipeEnBase(snTeamId, now);
}

/** Bilan d'une passe de préchargement des fiches joueurs (cf. `prechargerFichesPoules`). */
export interface PrechargementFiches {
  /** Équipes de nos poules qui avaient des simples publiés sans joueurs. */
  equipes: number;
  /** Fiches joueurs relues et rangées. */
  lues: number;
  failed: number;
  /** Fiches qu'il restait à lire quand le budget s'est épuisé : la passe suivante les reprend. */
  reportees: number;
}

/**
 * PRÉCHARGE, DANS LE PASSAGE D'APRÈS-MATCH, les fiches joueurs qui complètent les simples que la
 * poule publie sans joueurs (cf. `ligneSansJoueurs`).
 *
 * Sans elle, c'est le premier membre qui ouvre une équipe du classement qui paie la relecture —
 * jusqu'à une douzaine de fiches, une vingtaine de secondes. Ici, c'est le cron qui l'attend.
 *
 * TOUTES LES ÉQUIPES DES POULES DONNÉES, pas seulement les nôtres : c'est CAL ou Verrières qu'on
 * ouvre depuis le classement. Mais seulement celles qui ont un simple à compléter, et seulement
 * les fiches absentes ou relues avant la rencontre (`assembler`) : une fois lue, une fiche ne se
 * relit plus — la passe suivante ne coûte rien.
 *
 * BUDGET : `max` fiches au plus (espacées de `DELAI_MS`), et l'effectif de l'équipe relu s'il a
 * plus d'une semaine. Le surplus est reporté au passage suivant, quatre heures plus tard. Une
 * fiche en échec n'emporte pas les autres.
 */
export async function prechargerFichesPoules(
  roundIds: readonly string[],
  opts: { now?: Date; max?: number; delaiMs?: number } = {},
): Promise<PrechargementFiches> {
  const now = opts.now ?? new Date();
  const max = opts.max ?? 40;
  const delai = opts.delaiMs ?? DELAI_MS;
  const out: PrechargementFiches = { equipes: 0, lues: 0, failed: 0, reportees: 0 };
  const voulues = new Set(roundIds);
  const poules = (await nosPoules()).filter((p) => voulues.has(p.anchor.snRoundId));

  let premiere = true;
  const pause = async () => {
    if (!premiere && delai > 0) await new Promise((res) => setTimeout(res, delai));
    premiere = false;
  };
  const dejaLues = new Set<string>();

  for (const poule of poules) {
    const pool = await loadPool(poule.anchor.snRoundId);
    if (!pool) continue;
    for (const row of poule.standings) {
      const code = row.code;
      const snTeamId = row.snTeamId;
      if (!code || !snTeamId) continue;
      // Rien à compléter pour cette équipe : aucune lecture de plus.
      if (!pool.ties.some((t) => (t.homeCode === code || t.awayCode === code) && rencontreACompleter(t))) continue;
      out.equipes += 1;

      // Sans effectif rangé, pas de `regiid` : on le relit (une fois par semaine au plus).
      if (out.lues < max) {
        await pause();
        try {
          await refreshRosters([snTeamId], { now, delaiMs: 0 });
        } catch {
          /* un effectif déjà en cache reste exploitable */
        }
      }

      const aRelire = ((await assembler(snTeamId, now))?.aRelire ?? []).filter((r) => !dejaLues.has(r));
      for (const regiid of aRelire) {
        if (out.lues + out.failed >= max) {
          out.reportees += 1;
          continue;
        }
        dejaLues.add(regiid);
        await pause();
        try {
          await storePlayer(await fetchPlayer(regiid), now);
          echecsJoueur.delete(regiid);
          out.lues += 1;
        } catch (e) {
          console.warn("[interclub-team-sheet] fiche joueur non préchargée", regiid, e);
          echecsJoueur.set(regiid, now.getTime());
          out.failed += 1;
        }
      }
    }
  }
  return out;
}

/**
 * Ce joueur figure-t-il dans nos données — une rencontre de nos poules, ou un effectif rangé ?
 *
 * Par recherche de texte sur le JSON rangé, et c'est suffisant : l'identifiant est fait de
 * chiffres (vérifié avant), et la clé est sérialisée sans espace par `JSON.stringify`.
 */
async function joueurConnu(regiid: string): Promise<boolean> {
  const motif = `"regiid":"${regiid}"`;
  const [poules, rosters] = await Promise.all([
    prisma.squashnetPool.count({ where: { tiesJson: { contains: motif } } }),
    prisma.squashnetTeamRoster.count({ where: { rosterJson: { contains: motif } } }),
  ]);
  return poules + rosters > 0;
}

/** Toutes les rencontres et toutes les équipes de nos poules. */
async function toutesLesPoules(): Promise<{ ties: PoolTie[]; standings: StandingRow[] }> {
  const poules = await nosPoules();
  const lues = await Promise.all(poules.map((p) => loadPool(p.anchor.snRoundId)));
  return {
    ties: lues.flatMap((l) => l?.ties ?? []),
    standings: poules.flatMap((p) => p.standings),
  };
}

/**
 * L'historique mensuel du classement d'un joueur DU CLUB — membre ou joueur sans compte —,
 * retrouvé par sa LICENCE. Null s'il n'est pas des nôtres.
 *
 * Par la licence et non par le nom : la fiche fédérale la publie, et le rapprochement mensuel
 * l'a gardée (`SquashnetRanking.licence`, `InterclubGuest.snLicence`). Un égal exact, sans
 * deviner — un homonyme d'un autre club ne prendra jamais l'historique d'un des nôtres.
 */
async function historiqueDuClub(licence: string | null): Promise<ClassementMensuel[] | null> {
  const l = (licence ?? "").trim();
  if (!/^\d{4,12}$/.test(l)) return null;
  // La même licence, avec ou sans ses zéros de tête : selon la page, la ligue les garde ou non.
  const variantes = [...new Set([l, l.replace(/^0+/, "")])];
  const [membre, invite] = await Promise.all([
    prisma.squashnetRanking.findFirst({ where: { licence: { in: variantes } }, select: { userId: true } }),
    prisma.interclubGuest.findFirst({ where: { snLicence: { in: variantes } }, select: { id: true } }),
  ]);
  const sujet = membre ? { userId: membre.userId } : invite ? { guestId: invite.id } : null;
  if (!sujet) return null;
  return prisma.squashnetRankingPoint.findMany({
    where: sujet,
    select: { month: true, clt: true, rang: true, rangM: true },
    orderBy: { month: "asc" },
  });
}

/** La fiche d'un joueur, depuis la base seule. Null : joueur absent de nos données. */
export async function ficheJoueurEnBase(regiid: string, now: Date = new Date()): Promise<PlayerSheet | null> {
  if (!(await joueurConnu(regiid))) return null;
  const [cached, poules] = await Promise.all([loadPlayer(regiid), toutesLesPoules()]);
  const history = await historiqueDuClub(cached?.player.licence ?? null);
  return ficheJoueur({ regiid, cached, ...poules, history, now, fraisMs: JOUEUR_FRAIS_MS });
}

/** Relit la fiche fédérale du joueur si elle est trop ancienne (UNE requête), puis la rend. */
export async function ficheJoueurRafraichie(regiid: string, now: Date = new Date()): Promise<PlayerSheet | null> {
  if (!(await joueurConnu(regiid))) return null;
  const cached = await loadPlayer(regiid);
  const echec = echecsJoueur.get(regiid);
  if (
    (!cached || now.getTime() - cached.fetchedAt.getTime() > JOUEUR_FRAIS_MS) &&
    (echec === undefined || now.getTime() - echec >= ECHEC_REPOS_MS)
  ) {
    try {
      await storePlayer(await fetchPlayer(regiid), now);
      echecsJoueur.delete(regiid);
    } catch (e) {
      // RIEN N'EST ÉCRASÉ : la fiche d'hier, ou à défaut ce que la poule en dit, vaut mieux qu'un
      // écran vide. On se souvient seulement de l'échec, pour ne pas y retourner à chaque clic.
      console.warn("[interclub-team-sheet] fiche joueur non relue", regiid, e);
      echecsJoueur.set(regiid, now.getTime());
    }
  }
  return ficheJoueurEnBase(regiid, now);
}
