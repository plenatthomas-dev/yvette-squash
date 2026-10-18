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
import { loadPlayer, loadPool, storePlayer } from "./interclub-pool-db";
import { DELAI_MS, ECHEC_REPOS_MS, ROSTER_FRAIS_JOURS, loadRosters, refreshRosters } from "./interclub-roster-db";
import { refreshTeamStandings, type StandingsAnchor } from "./interclub-standings";
import { ficheEquipe, ficheJoueur, type PlayerSheet, type TeamSheet } from "./interclub-team-sheet";
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

/** La fiche d'une équipe, depuis la base seule. Null : équipe absente de nos poules. */
export async function ficheEquipeEnBase(snTeamId: string, now: Date = new Date()): Promise<TeamSheet | null> {
  const poule = await pouleDe(snTeamId);
  if (!poule) return null;
  const [pool, rosters, ligne] = await Promise.all([
    loadPool(poule.anchor.snRoundId),
    loadRosters([snTeamId]),
    prisma.squashnetTeamRoster.findUnique({ where: { snTeamId }, select: { fetchedAt: true } }),
  ]);
  const r = rosters.get(snTeamId);
  return ficheEquipe({
    snTeamId,
    standings: poule.standings,
    standingsAt: poule.standingsAt,
    pool,
    roster: r && ligne ? { players: r.players, club: r.club, captain: r.captain, fetchedAt: ligne.fetchedAt } : null,
    now,
    poolFraisMs: POULE_FRAIS_MS,
    rosterFraisMs: ROSTER_FRAIS_MS,
  });
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

  return ficheEquipeEnBase(snTeamId, now);
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

/** La fiche d'un joueur, depuis la base seule. Null : joueur absent de nos données. */
export async function ficheJoueurEnBase(regiid: string, now: Date = new Date()): Promise<PlayerSheet | null> {
  if (!(await joueurConnu(regiid))) return null;
  const [cached, poules] = await Promise.all([loadPlayer(regiid), toutesLesPoules()]);
  return ficheJoueur({ regiid, cached, ...poules, now, fraisMs: JOUEUR_FRAIS_MS });
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
