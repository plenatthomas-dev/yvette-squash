// ============================================================================
//  LA FEUILLE OFFICIELLE REMPLIT LA RENCONTRE DE L'APPLI.
//
//  Le cas qui l'a fait naître : la ligue saisit parfois la feuille de match sur
//  squashnet AVANT que quiconque ait marqué la soirée dans l'appli. La rencontre
//  restait alors « à saisir » dans le haut de l'écran pendant des jours, alors
//  que le score officiel était déjà publié.
//
//  CE QU'ON IMPORTE, ET CE QU'ON NE TOUCHE JAMAIS :
//
//    * seulement une feuille COMPLÈTE (tous les simples tranchés) dont NOTRE CÔTÉ
//      est reconnu — sinon on attribuerait nos défaites à nos joueurs ;
//    * seulement une rencontre que l'appli n'a pas déjà TERMINÉE ;
//    * et, dans cette rencontre, seulement les simples non terminés : un score
//      marqué au bord du terrain n'est jamais écrasé.
//
//  AUCUNE NOTIFICATION. Un import peut rattraper une saison entière d'un coup ;
//  envoyer un résultat par rencontre noierait les abonnés sous des nouvelles de
//  la semaine dernière. Les marqueurs de fin sont posés en silence, pour qu'une
//  correction ultérieure ne réannonce pas un résultat comme neuf.
// ============================================================================

import { prisma } from "./db";
import { serializableTransaction } from "./http-tx";
import { derivedStatus, fixtureScore } from "./interclub-db";
import { interclubChanged, todayISO } from "./interclub-gate";
import { sequenceWinner, UNSET_PLAYER, type GameScore } from "./interclub";
import { loadRosters } from "./interclub-roster-db";
import {
  feuilleComplete,
  identityResolver,
  lireCote,
  lireFeuille,
  nomLisible,
  type AppPlayer,
  type FederalEntry,
  type StatIdentity,
} from "./interclub-stats";
import type { TieLine, TieSheet } from "./squashnet/tie";

/**
 * « 11-6 11-3 8-11 11-0 » (côté A d'abord) → les jeux DE NOTRE POINT DE VUE. PUR, testé.
 *
 * Null dès qu'un morceau ne se lit pas (« WO », « forfait », texte vide) : on ne devine pas un
 * jeu, le simple est alors importé sur son seul total de jeux.
 */
export function parseSheetScore(score: string | null, side: "A" | "B"): GameScore[] | null {
  if (!score || !score.trim()) return null;
  const jeux: GameScore[] = [];
  for (const bout of score.trim().split(/\s+/)) {
    const m = /^(\d{1,2})-(\d{1,2})$/.exec(bout);
    if (!m) return null;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === b) return null;
    jeux.push(side === "A" ? { home: a, away: b } : { home: b, away: a });
  }
  return jeux.length ? jeux : null;
}

/** Ce qu'on écrit sur UN simple de l'appli à partir d'UNE ligne de la feuille. */
export interface LineImport {
  order: number;
  /** Notre joueur tel que la feuille le nomme — null : case vide (forfait de notre côté). */
  ourName: string | null;
  /** L'adversaire, en casse lisible — null : case vide. */
  awayName: string | null;
  /** Jeux joués, de notre point de vue ; vide quand le score n'est pas lisible. */
  games: GameScore[];
  gamesHome: number;
  gamesAway: number;
  /** Simple gagné par… */
  winner: "home" | "away";
  /** « forfait » quand aucun jeu n'est lisible : le total seul porte le résultat. */
  outcome: "forfait" | null;
}

/**
 * Une ligne de feuille → l'écriture d'un simple. PUR, testé.
 *
 * Null si la ligne n'est pas tranchée : une feuille complète n'en a pas, mais on ne présume rien.
 */
export function lineImport(line: TieLine, order: number, side: "A" | "B", bestOf: number): LineImport | null {
  if (line.winner === null) return null;
  const nous = side === "A" ? line.a : line.b;
  const eux = side === "A" ? line.b : line.a;
  const winner: "home" | "away" = line.winner === side ? "home" : "away";
  const [gn, ge] = side === "A" ? [line.gamesA, line.gamesB] : [line.gamesB, line.gamesA];

  const parsed = parseSheetScore(line.score, side);
  // Le jeu par jeu n'est gardé que s'il DIT LA MÊME CHOSE que la ligue : même vainqueur au
  // format de la rencontre. Sinon (format différent, abandon en cours de jeu…), on se replie
  // sur le total publié — juste, simplement moins détaillé.
  const games = parsed && sequenceWinner(parsed, bestOf) === winner ? parsed : [];
  const won = (s: "home" | "away") =>
    games.filter((g) => (s === "home" ? g.home > g.away : g.away > g.home)).length;

  const gamesHome = games.length ? won("home") : (gn ?? (winner === "home" ? 1 : 0));
  const gamesAway = games.length ? won("away") : (ge ?? (winner === "away" ? 1 : 0));
  return {
    order,
    ourName: nous?.name ?? null,
    awayName: eux ? nomLisible(eux.name) : null,
    games,
    gamesHome,
    gamesAway,
    winner,
    outcome: games.length ? null : "forfait",
  };
}

/** La rencontre de l'appli, réduite à ce que l'import doit savoir. */
export interface ImportTarget {
  bestOf: number;
  matches: { order: number; status: string }[];
}

/**
 * Les simples à écrire. PUR, testé.
 *
 * Null = rien à importer (feuille incomplète, côté inconnu). Les simples déjà TERMINÉS dans
 * l'appli sont écartés : la saisie humaine prime toujours.
 */
export function planSheetImport(
  sheet: TieSheet | null,
  side: "A" | "B" | null,
  target: ImportTarget,
): LineImport[] | null {
  if (!sheet || !side || !feuilleComplete(sheet)) return null;
  const finis = new Set(target.matches.filter((m) => m.status === "done").map((m) => m.order));
  const out: LineImport[] = [];
  sheet.lines.forEach((l, i) => {
    const order = i + 1;
    if (finis.has(order)) return;
    const li = lineImport(l, order, side, target.bestOf);
    if (li) out.push(li);
  });
  return out;
}

// ---------------------------------------------------------------------------
//  Qui est qui — partagé avec le palmarès (`/api/interclub/stats`).
// ---------------------------------------------------------------------------

/**
 * Les joueurs de l'appli et nos inscrits fédéraux : de quoi relier un nom de feuille à un
 * membre ou à un joueur sans compte (cf. `identityResolver`).
 */
export async function loadIdentitySources(): Promise<{ players: AppPlayer[]; federal: FederalEntry[] }> {
  const [membres, invites, equipes] = await Promise.all([
    // Les comptes désactivés RESTENT : leurs matchs ont été joués.
    prisma.user.findMany({
      where: { OR: [{ teamId: { not: null } }, { snLicence: { not: null } }] },
      select: {
        id: true,
        displayName: true,
        nickname: true,
        snLicence: true,
        squashnetGivenName: true,
        squashnetFamilyName: true,
      },
    }),
    prisma.interclubGuest.findMany({ select: { id: true, name: true, snLicence: true } }),
    prisma.interclubTeam.findMany({ select: { snTeamId: true } }),
  ]);
  const players: AppPlayer[] = [
    ...membres.map((u) => ({
      kind: "member" as const,
      id: u.id,
      name: u.nickname ?? u.displayName,
      licence: u.snLicence,
      altNames: [
        u.displayName,
        [u.squashnetFamilyName, u.squashnetGivenName].filter(Boolean).join(" "),
      ].filter(Boolean),
    })),
    ...invites.map((g) => ({ kind: "guest" as const, id: g.id, name: g.name, licence: g.snLicence })),
  ];
  const fiches = await loadRosters(equipes.map((e) => e.snTeamId).filter((v): v is string => !!v));
  const federal = [...fiches.values()].flatMap((r) => r.players);
  return { players, federal };
}

/** L'identité résolue → les trois colonnes « qui joue » d'un simple. */
function homePlayer(
  id: StatIdentity | null,
  current: { homeUserId: string | null; homeGuestId: string | null; homeDisplayName: string },
): { homeUserId: string | null; homeGuestId: string | null; homeDisplayName: string } {
  if (id?.key.startsWith("u:")) return { homeUserId: id.key.slice(2), homeGuestId: null, homeDisplayName: id.name };
  if (id?.key.startsWith("g:")) return { homeUserId: null, homeGuestId: id.key.slice(2), homeDisplayName: id.name };
  // Joueur que l'appli ne connaît pas : on garde celui qu'un capitaine aurait déjà aligné,
  // sinon on écrit le nom fédéral, remis en casse lisible.
  if (current.homeDisplayName !== UNSET_PLAYER) return current;
  return { homeUserId: null, homeGuestId: null, homeDisplayName: id?.name ?? UNSET_PLAYER };
}

/**
 * Importe dans l'appli les résultats officiels des rencontres d'une équipe que l'appli n'a pas
 * encore terminées. Rend le nombre de rencontres complétées.
 *
 * Une rencontre en échec n'emporte pas les autres.
 */
export async function importSheetResults(teamId: string, now: Date = new Date()): Promise<number> {
  const rencontres = await prisma.interclub.findMany({
    where: {
      teamId,
      status: { not: "done" },
      date: { lte: todayISO(now) },
      snSheetJson: { not: null },
      snSheetSide: { not: null },
    },
    select: { id: true, snSheetJson: true, snSheetSide: true },
  });
  // Lecture des feuilles d'abord : la résolution d'identité (trois requêtes) n'est payée que
  // s'il y a vraiment quelque chose à importer.
  const candidates = rencontres.filter((r) => feuilleComplete(lireFeuille(r.snSheetJson)) && lireCote(r.snSheetSide));
  if (candidates.length === 0) return 0;

  const { players, federal } = await loadIdentitySources();
  const identify = identityResolver(players, federal);

  let imported = 0;
  for (const r of candidates) {
    try {
      if (await importOne(r.id, identify)) imported += 1;
    } catch (e) {
      console.warn("[interclub-sheet-import] rencontre non importée", r.id, e);
    }
  }
  if (imported > 0) interclubChanged();
  return imported;
}

async function importOne(id: string, identify: (fedName: string) => StatIdentity): Promise<boolean> {
  return serializableTransaction(async (tx) => {
    // Relue DANS la transaction : un marqueur a pu terminer la rencontre entre-temps.
    const f = await tx.interclub.findUnique({
      where: { id },
      select: {
        status: true,
        matchCount: true,
        bestOf: true,
        snSheetJson: true,
        snSheetSide: true,
        doneNotifiedAt: true,
        startNotifiedAt: true,
        matches: {
          orderBy: { order: "asc" },
          select: {
            id: true,
            order: true,
            status: true,
            homeUserId: true,
            homeGuestId: true,
            homeDisplayName: true,
            awayName: true,
          },
        },
      },
    });
    if (!f || f.status === "done") return false;
    const sheet = lireFeuille(f.snSheetJson);
    const plan = planSheetImport(sheet, lireCote(f.snSheetSide), f);
    if (!plan || !sheet) return false;

    // La feuille fait foi sur le NOMBRE de simples : s'il en manque chez nous, on les crée.
    const nb = Math.max(f.matchCount, sheet.lines.length);
    const parOrdre = new Map(f.matches.map((m) => [m.order, m]));

    for (const li of plan) {
      const current = parOrdre.get(li.order) ?? {
        homeUserId: null,
        homeGuestId: null,
        homeDisplayName: UNSET_PLAYER,
        awayName: UNSET_PLAYER,
      };
      const qui = homePlayer(li.ourName ? identify(li.ourName) : null, current);
      const data = {
        ...qui,
        awayName: current.awayName !== UNSET_PLAYER ? current.awayName : (li.awayName ?? UNSET_PLAYER),
        status: "done",
        gamesHome: li.gamesHome,
        gamesAway: li.gamesAway,
        outcome: li.outcome,
        outcomeWinner: li.outcome ? li.winner : null,
        scorerId: null,
        scorerClaimedAt: null,
        liveJson: null,
        liveRev: { increment: 1 },
      };
      const existant = parOrdre.get(li.order);
      const matchId = existant
        ? (await tx.interclubMatch.update({ where: { id: existant.id }, data, select: { id: true } })).id
        : (
            await tx.interclubMatch.create({
              data: { ...data, liveRev: 1, interclubId: id, order: li.order },
              select: { id: true },
            })
          ).id;
      await tx.interclubGame.deleteMany({ where: { matchId } });
      if (li.games.length) {
        await tx.interclubGame.createMany({
          data: li.games.map((g, i) => ({ matchId, number: i + 1, pointsHome: g.home, pointsAway: g.away })),
        });
      }
    }

    const siblings = await tx.interclubMatch.findMany({
      where: { interclubId: id },
      select: { gamesHome: true, gamesAway: true, status: true },
    });
    const status = derivedStatus(nb, siblings);
    const score = fixtureScore(siblings);
    await tx.interclub.update({
      where: { id },
      data: {
        status,
        ...(nb !== f.matchCount ? { matchCount: nb } : {}),
        ...(!f.startNotifiedAt ? { startNotifiedAt: new Date() } : {}),
        // Silencieux (cf. en-tête) : on pose les marqueurs comme si l'annonce était partie.
        ...(status === "done" && !f.doneNotifiedAt
          ? { doneNotifiedAt: new Date(), doneNotifiedScore: `${score.home}-${score.away}` }
          : {}),
      },
    });
    return status === "done";
  }, "Import concurrent, réessaie");
}

// ---------------------------------------------------------------------------
//  SCORE CORRIGÉ APRÈS COUP : la nouvelle feuille met à jour la rencontre.
// ---------------------------------------------------------------------------
//
// Deux cas : la feuille OFFICIELLE remplace une feuille reconstituée depuis la poule (où deux
// simples de même score ont pu être intervertis), ou la ligue CORRIGE une feuille déjà publiée.
// La rencontre de l'appli, terminée depuis, n'était plus touchée par l'import.
//
// LA RÈGLE : un simple n'est mis à jour que si la feuille a changé POUR LUI, et s'il porte encore
// exactement le résultat que l'ANCIENNE feuille donnait. C'est le signe que personne n'y a touché
// depuis — ou qu'on y avait saisi la même chose que la ligue, qui fait foi. Un simple corrigé à la
// main dans l'appli, qui ne correspond plus à l'ancienne feuille, n'est jamais écrasé.
//
// Silencieux, comme l'import : aucune notification. Le score « annoncé » est recalé en silence,
// pour qu'une correction manuelle ultérieure ne réannonce pas l'ancien résultat.

/** Un simple de l'appli, réduit à ce qui dit s'il porte encore le résultat importé. */
export interface AppMatchState {
  id: string;
  order: number;
  status: string;
  gamesHome: number | null;
  gamesAway: number | null;
  outcome: string | null;
  games: GameScore[];
}

const memesJeux = (a: readonly GameScore[], b: readonly GameScore[]) =>
  a.length === b.length && a.every((g, i) => g.home === b[i].home && g.away === b[i].away);

/** Le simple de l'appli porte-t-il exactement ce résultat ? PUR, testé. */
export function porteLeResultat(m: AppMatchState, li: LineImport): boolean {
  return (
    m.status === "done" &&
    m.gamesHome === li.gamesHome &&
    m.gamesAway === li.gamesAway &&
    (m.outcome ?? null) === li.outcome &&
    memesJeux(m.games, li.games)
  );
}

const memeLigne = (a: LineImport, b: LineImport) =>
  a.ourName === b.ourName &&
  a.awayName === b.awayName &&
  a.winner === b.winner &&
  porteLeResultat({ ...a, id: "", status: "done" }, b);

/**
 * Les simples à mettre à jour quand la feuille d'une rencontre change. PUR, testé.
 *
 * Rien si l'une des deux feuilles est incomplète ou sans notre côté : l'ancienne n'a alors rien
 * importé, la nouvelle n'a rien de sûr à dire.
 */
export function planCorrection(
  ancienne: TieSheet | null,
  ancienCote: "A" | "B" | null,
  nouvelle: TieSheet | null,
  nouveauCote: "A" | "B" | null,
  bestOf: number,
  matches: readonly AppMatchState[],
): { matchId: string; li: LineImport }[] {
  if (!ancienne || !ancienCote || !nouvelle || !nouveauCote) return [];
  if (!feuilleComplete(ancienne) || !feuilleComplete(nouvelle)) return [];
  const parOrdre = new Map(matches.map((m) => [m.order, m]));
  const out: { matchId: string; li: LineImport }[] = [];
  nouvelle.lines.forEach((l, i) => {
    const avant = ancienne.lines[i];
    if (!avant) return;
    const a = lineImport(avant, i + 1, ancienCote, bestOf);
    const n = lineImport(l, i + 1, nouveauCote, bestOf);
    if (!a || !n || memeLigne(a, n)) return;
    const m = parOrdre.get(i + 1);
    if (!m || !porteLeResultat(m, a)) return;
    out.push({ matchId: m.id, li: n });
  });
  return out;
}

const selectionCorrection = {
  status: true,
  matchCount: true,
  bestOf: true,
  snSheetJson: true,
  snSheetSide: true,
  doneNotifiedAt: true,
  matches: {
    orderBy: { order: "asc" as const },
    select: {
      id: true,
      order: true,
      status: true,
      gamesHome: true,
      gamesAway: true,
      outcome: true,
      awayName: true,
      games: { orderBy: { number: "asc" as const }, select: { pointsHome: true, pointsAway: true, finishedAt: true } },
    },
  },
};

type FixtureCorrection = {
  bestOf: number;
  snSheetJson: string | null;
  snSheetSide: string | null;
  matches: {
    id: string;
    order: number;
    status: string;
    gamesHome: number | null;
    gamesAway: number | null;
    outcome: string | null;
    games: { pointsHome: number; pointsAway: number }[];
  }[];
};

const planPour = (f: FixtureCorrection, ancienJson: string, ancienCote: string | null) =>
  planCorrection(
    lireFeuille(ancienJson),
    lireCote(ancienCote),
    lireFeuille(f.snSheetJson),
    lireCote(f.snSheetSide),
    f.bestOf,
    f.matches.map((m) => ({ ...m, games: m.games.map((g) => ({ home: g.pointsHome, away: g.pointsAway })) })),
  );

/**
 * Reporte dans la rencontre la correction apportée par sa NOUVELLE feuille (déjà rangée), par
 * rapport à l'ancienne. Rend le nombre de simples mis à jour.
 */
export async function reporterCorrection(id: string, ancienJson: string, ancienCote: string | null): Promise<number> {
  const avant = await prisma.interclub.findUnique({ where: { id }, select: selectionCorrection });
  if (!avant || planPour(avant, ancienJson, ancienCote).length === 0) return 0;

  // La résolution d'identité (trois requêtes) n'est payée que s'il y a vraiment à corriger.
  const { players, federal } = await loadIdentitySources();
  const identify = identityResolver(players, federal);

  const n = await serializableTransaction(async (tx) => {
    // Relue DANS la transaction : quelqu'un a pu corriger le simple entre-temps.
    const f = await tx.interclub.findUnique({ where: { id }, select: selectionCorrection });
    if (!f) return 0;
    const plan = planPour(f, ancienJson, ancienCote);
    if (plan.length === 0) return 0;
    const parId = new Map(f.matches.map((m) => [m.id, m]));

    for (const { matchId, li } of plan) {
      const m = parId.get(matchId);
      if (!m) continue;
      const id2 = li.ourName ? identify(li.ourName) : null;
      const qui = id2?.key.startsWith("u:")
        ? { homeUserId: id2.key.slice(2), homeGuestId: null, homeDisplayName: id2.name }
        : id2?.key.startsWith("g:")
          ? { homeUserId: null, homeGuestId: id2.key.slice(2), homeDisplayName: id2.name }
          : id2
            ? { homeUserId: null, homeGuestId: null, homeDisplayName: id2.name }
            : {};
      await tx.interclubMatch.update({
        where: { id: matchId },
        data: {
          ...qui,
          ...(li.awayName ? { awayName: li.awayName } : {}),
          gamesHome: li.gamesHome,
          gamesAway: li.gamesAway,
          outcome: li.outcome,
          outcomeWinner: li.outcome ? li.winner : null,
          liveJson: null,
          liveRev: { increment: 1 },
        },
      });
      await tx.interclubGame.deleteMany({ where: { matchId } });
      if (li.games.length) {
        await tx.interclubGame.createMany({
          // Un jeu inchangé garde l'heure du marquage en direct ; aucune heure n'est inventée.
          data: li.games.map((g, i) => {
            const ancien = m.games[i];
            const garde = ancien && ancien.pointsHome === g.home && ancien.pointsAway === g.away;
            return {
              matchId,
              number: i + 1,
              pointsHome: g.home,
              pointsAway: g.away,
              finishedAt: garde ? ancien.finishedAt : null,
            };
          }),
        });
      }
    }

    const siblings = await tx.interclubMatch.findMany({
      where: { interclubId: id },
      select: { gamesHome: true, gamesAway: true, status: true },
    });
    const status = derivedStatus(f.matchCount, siblings);
    const score = fixtureScore(siblings);
    await tx.interclub.update({
      where: { id },
      data: {
        status,
        // Silencieux : le score « annoncé » suit la correction, sans nouvelle annonce.
        ...(status === "done" && f.doneNotifiedAt ? { doneNotifiedScore: `${score.home}-${score.away}` } : {}),
      },
    });
    return plan.length;
  }, "Correction concurrente, réessaie");

  if (n > 0) interclubChanged();
  return n;
}
