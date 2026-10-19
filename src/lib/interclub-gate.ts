// Porte d'entrée BON MARCHÉ du suivi en direct : « où en sont les rencontres du jour ? »
//
// POURQUOI CE MODULE EXISTE
// Un soir de rencontre, plusieurs membres gardent la page ouverte et l'interrogent toutes les
// dix secondes pendant deux heures. Sans précaution, chaque interrogation de chaque spectateur
// serait une lecture Postgres — Neon resterait éveillé et la facture croîtrait avec l'audience,
// ce que `PRODUCT.md` proscrit explicitement (« pas de polling agressif, pas de requête DB
// supplémentaire sur un chemin chaud »).
//
// La réponse vit donc dans le Data Cache de Vercel, invalidé par tag à chaque écriture du
// marqueur. La requête de rencontres — la plus lourde, avec ses jointures sur les matchs et les
// jeux — est ainsi bornée par la CADENCE DU MARQUEUR (une écriture toutes les 5 s au plus) et
// non par le nombre de spectateurs.
//
// ⚠️ Ce que ce cache n'épargne PAS : `getSession` lit la table `Session` à chaque appel, sans
// cache. Le coût par sondage n'est donc pas nul, il est réduit à cette seule lecture par clé
// primaire. Dire que « dix spectateurs coûtent une seule lecture Postgres » serait faux — ils
// en coûtent dix légères au lieu de dix lourdes, et le compute Neon reste éveillé pendant la
// soirée de toute façon, puisque le marqueur écrit.
//
// ⚠️ POURQUOI PAS LE CACHE CDN, contrairement à ce que prévoyait l'étude initiale.
// Mettre `Cache-Control: public, s-maxage=…` sur cette route aurait effondré les spectateurs en
// un seul appel origine — mais un cache PARTAGÉ indexe sur l'URL, pas sur le cookie de session.
// La première réponse servie à un membre connecté aurait ensuite été rendue à N'IMPORTE QUELLE
// requête, y compris non authentifiée : les noms des joueurs seraient devenus publics. Ajouter
// `Vary: Cookie` ferait une entrée de cache par session, donc supprimerait tout le bénéfice.
// Le Data Cache, lui, vit CÔTÉ SERVEUR, derrière le contrôle de session : on garde l'économie
// sur Postgres — la ressource réellement rare — sans ouvrir la donnée.

import { unstable_cache, revalidateTag } from "next/cache";
import { prisma } from "./db";
import { CLUB_TZ, clubNowWall } from "./time";
import { isRecentFixture, normalizeColor, RECENT_FIXTURE_FLOOR_DAYS, shiftISO } from "./interclub";
import { derivedStatus, fixtureScore, parseLive } from "./interclub-db";

/**
 * Invalidé par `interclubChanged()`, donc par toute écriture de rencontre. Exporté pour les
 * autres caches qui dépendent des rencontres (cf. `lib/interclub-standings.ts`) : ils héritent
 * ainsi de chaque appel déjà en place au lieu d'en exiger un second, qu'on finirait par oublier.
 */
export const INTERCLUB_TAG = "interclub-live";
const TAG = INTERCLUB_TAG;

/**
 * Filet de sécurité court : une invalidation manquée ne fige l'affichage que 30 secondes.
 * On reste très en dessous de la cadence d'une soirée, tout en évitant de relire Postgres
 * quand rien ne bouge (entre deux matchs, à la pause).
 */
const TTL_S = 30;

/**
 * Bornes de la charge utile du direct, relue et resérialisée toutes les dix secondes par
 * chaque spectateur.
 *
 * La fenêtre est celle du HAUT DE L'ÉCRAN : les rencontres du jour, et celles commencées depuis
 * moins de `RECENT_FIXTURE_HOURS` heures — terminées ou non — qu'on y garde pour finir d'en
 * saisir les scores (demande du club, 2026-10-16 ; 60 h depuis le 2026-10-19). Elle couvre au
 * passage la soirée qui déborde après minuit, raison d'être de l'ancien plancher à deux jours.
 *
 * Huit rencontres : nos deux équipes jouent au plus une fois par semaine chacune, cinq jours
 * en comptent donc quatre au pire — le double laisse la marge d'une journée reportée.
 */
const LIVE_MAX_FIXTURES = 8;

/**
 * Date plancher du direct, en heure murale du club. Au JOUR près, donc large : la base ne sait
 * pas comparer une date et une heure rangées en chaînes séparées. Le tri fin, à l'heure, se
 * fait ensuite (`isRecentFixture`).
 */
function floorISO(now: Date = new Date()): string {
  return shiftISO(todayISO(now), -RECENT_FIXTURE_FLOOR_DAYS);
}

/** Date du jour en heure MURALE du club (règle unique du projet, cf. lib/time.ts). */
export function todayISO(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: CLUB_TZ });
}

export interface LiveMatch {
  id: string;
  order: number;
  home: string;
  away: string;
  homeColor: string | null;
  awayColor: string | null;
  status: string;
  gamesHome: number | null;
  gamesAway: number | null;
  games: { home: number; away: number }[];
  live: { current: { home: number; away: number }; serving: "home" | "away" | null } | null;
}

export interface LiveFixture {
  id: string;
  date: string;
  /** Heure de début, « HH:MM » murale — ce qui dit, à l'heure près, quand elle cesse d'être récente. */
  time: string | null;
  teamId: string;
  teamName: string;
  opponent: string;
  home: boolean;
  /**
   * Nombre de simples de la rencontre. Publié parce que le compteur d'avance en a besoin pour
   * savoir COMBIEN il en reste, donc si un nul — et donc l'average — est encore atteignable.
   * Il vient de la ligne déjà lue : aucune requête de plus.
   */
  matchCount: number;
  status: string;
  score: { home: number; away: number };
  matches: LiveMatch[];
}

async function readLive(): Promise<LiveFixture[]> {
  const today = todayISO();
  const rows = await prisma.interclub.findMany({
    // Rien de FUTUR : le haut de l'écran montre ce qui se joue et ce qui vient de se jouer, le
    // calendrier est dans la liste en dessous.
    //
    // Une date passée mais PRÉVISIONNELLE n'est pas une rencontre jouée : c'est la date
    // bouchon que la fédération pose sur les journées non planifiées (cf. `dateConfirmed`).
    // Elle n'entre que si quelqu'un y a saisi quelque chose — ce qui prouve qu'elle a eu lieu.
    where: {
      date: { gte: floorISO(), lte: today },
      OR: [{ date: today }, { dateConfirmed: true }, { status: { not: "scheduled" } }],
    },
    orderBy: [{ date: "desc" }],
    take: LIVE_MAX_FIXTURES,
    include: {
      team: { select: { id: true, name: true } },
      matches: {
        orderBy: { order: "asc" },
        include: { games: { orderBy: { number: "asc" } } },
      },
    },
  });

  // À L'HEURE PRÈS : le plancher de la requête n'est qu'au jour. Le cache garde ce tri au plus
  // `TTL_S` secondes de trop, et l'écran le refait de son côté à chaque rendu.
  const maintenant = clubNowWall();
  return rows.filter((f) => f.date === today || isRecentFixture(f, maintenant)).map((f) => ({
    id: f.id,
    date: f.date,
    time: f.time,
    teamId: f.teamId,
    teamName: f.team.name,
    opponent: f.opponent,
    home: f.home,
    matchCount: f.matchCount,
    // Statut DÉDUIT des matchs, pas la colonne stockée. Deux marqueurs qui écrivent en même
    // temps sur deux matchs de la même rencontre peuvent laisser cette colonne en retard
    // (chacun relit les matchs voisins avant que l'autre n'ait écrit). La colonne se
    // recale d'elle-même au prochain affichage du détail, mais le direct, lui, doit être
    // juste TOUT DE SUITE — c'est son seul intérêt.
    status: derivedStatus(f.matchCount, f.matches),
    score: fixtureScore(f.matches),
    matches: f.matches.map((m) => {
      const snap = m.status === "live" ? parseLive(m.liveJson) : null;
      return {
        id: m.id,
        order: m.order,
        home: m.homeDisplayName,
        away: m.awayName,
        homeColor: normalizeColor(m.homeColor),
        awayColor: normalizeColor(m.awayColor),
        status: m.status,
        gamesHome: m.gamesHome,
        gamesAway: m.gamesAway,
        games: m.games.map((g) => ({ home: g.pointsHome, away: g.pointsAway })),
        // On ne publie du direct que le score et le serveur. Le carré de service intéresse
        // le marqueur, pas le spectateur : autant ne pas l'exposer.
        live: snap ? { current: snap.current, serving: snap.serving } : null,
      };
    }),
  }));
}

/**
 * Enveloppe d'une exception venue de la LECTURE, pour ne pas la confondre avec une panne du
 * CACHE. Les deux remontaient par le même `catch`, et le repli les traitait pareil.
 *
 * Conséquence, exactement au mauvais moment : quand c'est Postgres qui refuse — veille, quota
 * compute dépassé —, l'exception traversait `liveCached` et le repli relançait aussitôt la même
 * requête lourde. Dix spectateurs qui sondent produisaient vingt tentatives par cycle au lieu
 * de dix, sur une base qui venait justement de dire non. Le commentaire promettait « dégradé en
 * coût » : il l'était du double, et pour rien — une base injoignable ne le devient pas moins
 * parce qu'on insiste dans la milliseconde.
 */
class LectureEchouee extends Error {
  constructor(readonly cause: unknown) {
    super("lecture du direct impossible");
    this.name = "LectureEchouee";
  }
}

/**
 * `instanceof` d'abord ; le nom ensuite, au cas où le cache reconstruirait l'erreur en la
 * faisant traverser sa frontière. Ce détail d'implémentation ne doit pas décider d'une seconde
 * requête sur une base en difficulté.
 */
function vientDeLaLecture(e: unknown): boolean {
  return e instanceof LectureEchouee || (e as { name?: string } | null)?.name === "LectureEchouee";
}

const liveCached = unstable_cache(
  async () => {
    try {
      return await readLive();
    } catch (e) {
      throw new LectureEchouee(e);
    }
  },
  ["interclub-live"],
  { tags: [TAG], revalidate: TTL_S },
);

/**
 * État des rencontres en cours, servi par le Data Cache. Ne touche Postgres qu'en cas de miss
 * (invalidation par le marqueur, TTL écoulé) — ou de panne du CACHE, auquel cas on lit
 * directement la base : dégradé en coût, jamais en exactitude.
 *
 * Une panne de la LECTURE, elle, remonte telle quelle : le repli n'a rien à offrir contre une
 * base qui ne répond pas, et réessayer sur-le-champ ne ferait que doubler la charge.
 */
export async function getLiveFixtures(): Promise<LiveFixture[]> {
  try {
    return await liveCached();
  } catch (e) {
    if (vientDeLaLecture(e)) throw (e as LectureEchouee).cause ?? e;
    return readLive();
  }
}

/**
 * À appeler dès qu'un score a pu changer : point marqué, jeu terminé, saisie a posteriori,
 * suppression d'une rencontre.
 *
 * ⚠️ Même portée que `alertsChanged` : `revalidateTag` n'invalide pas sur-le-champ, Next purge
 * le tag APRÈS la réponse. Inutile de vouloir forcer un recalcul dans la même requête.
 */
export function interclubChanged(): void {
  try {
    // `{ expire: 0 }` : expiration IMMÉDIATE, comme avant Next 16 (qui exige désormais ce second
    // argument — un profil « max » servirait l'ancienne valeur le temps de la recalculer).
    revalidateTag(TAG, { expire: 0 });
  } catch (e) {
    // Ne JAMAIS faire échouer une écriture de score pour un problème de cache : au pire les
    // spectateurs voient l'ancien état pendant le TTL (30 s). `revalidateTag` lève hors
    // contexte de requête, et laisse remonter les erreurs de son magasin.
    console.warn("[interclub] invalidation du cache impossible", e);
  }
}
