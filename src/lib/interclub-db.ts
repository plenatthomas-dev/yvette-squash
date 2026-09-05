// Colle entre la base et l'API pour l'interclub. Contrairement à `interclub.ts` (moteur pur),
// ce module connaît Prisma — il ne doit donc JAMAIS être importé depuis un composant client.

import { Prisma } from "@prisma/client";
import {
  normalizeColor,
  UNSET_PLAYER,
  winGamesFor,
  type GameScore,
  type Side,
} from "./interclub";

export const interclubInclude = {
  // Le CAPITAINE vient avec l'équipe : la fiche d'une rencontre l'affiche pour que chacun sache
  // à qui parler sans avoir à demander. C'est une jointure de plus sur une requête déjà faite,
  // pas une requête de plus.
  team: { include: { captain: { select: { id: true, displayName: true, nickname: true } } } },
  matches: {
    orderBy: { order: "asc" },
    include: {
      games: { orderBy: { number: "asc" } },
      // Qui tient le marquage : l'écran doit pouvoir dire « Thomas marque ce match »
      // plutôt que de laisser croire que la prise est libre.
      scorer: { select: { id: true, displayName: true, nickname: true } },
    },
  },
} satisfies Prisma.InterclubInclude;

export type FullInterclub = Prisma.InterclubGetPayload<{ include: typeof interclubInclude }>;

/** Longueurs maximales des champs libres, alignées sur les usages du reste de l'appli. */
export const MAX_OPPONENT_LEN = 60;
export const MAX_PLAYER_NAME_LEN = 40;
export const MAX_SEASON_LEN = 12;
/** Lieu de la rencontre : nom du club hôte, puis son adresse postale, tels que publiés. */
export const MAX_VENUE_LEN = 80;
export const MAX_VENUE_ADDRESS_LEN = 200;
/** Journée de championnat (« J1 », « J14 »). Court par nature. */
export const MAX_ROUND_LEN = 8;

/**
 * Heure de début, « HH:MM ». Chaîne vide ⇒ null (« on ne sait pas encore »), ce qui est un cas
 * NORMAL : une rencontre s'inscrit souvent avant que la ligue ait publié les horaires.
 *
 * Lecture stricte des DEUX bornes, et pas seulement de la forme : `29:70` a la bonne allure,
 * s'écrirait tel quel dans une colonne `String`, et s'afficherait à l'équipe. C'est la même
 * leçon que `isRealDateISO` pour la date — la forme ne suffit jamais.
 */
export function parseTimeInput(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === undefined || v === null || v === "") return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false };
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return { ok: false };
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return { ok: false };
  return { ok: true, value: `${String(h).padStart(2, "0")}:${m[2]}` };
}

/**
 * Champ texte facultatif : compacté, tronqué, vide ⇒ null — et MAL TYPÉ ⇒ refus.
 *
 * TROIS CAS, ET ILS SE DISTINGUENT. La version précédente rendait `null` pour tout ce qui
 * n'était pas une chaîne, ce qui confondait « efface ce champ » avec « ce corps est faux » :
 * `PATCH {"venue": 42}` répondait 200 et le lieu disparaissait. Sur le même corps, `opponent`
 * refusait en 400 et quatre champs effaçaient en silence — une asymétrie qui ne se voyait que
 * dans le code, jamais à l'usage.
 *
 * La forme discriminée est celle de `parseTimeInput` juste au-dessus, et pour la même raison :
 * un refus doit être une valeur qu'on ne peut pas oublier de regarder. L'appelant garde la
 * distinction restante — champ ABSENT (`undefined`, on ne touche pas) contre `null` explicite
 * (on efface) —, que seule la présence de la clé dans le corps peut trancher.
 */
export function parseOptionalText(
  v: unknown,
  max: number,
): { ok: true; value: string | null } | { ok: false } {
  if (v === null) return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false };
  const t = v.trim().replace(/\s+/g, " ").slice(0, max);
  return { ok: true, value: t || null };
}

/**
 * Réexport de commodité pour le code serveur : la définition vit dans le moteur pur
 * (`interclub.ts`), seul module que le client et le serveur importent tous les deux.
 */
export { UNSET_PLAYER };

/**
 * Une prise de marquage est PÉRIMÉE au-delà de ce délai sans activité DU MARQUEUR : sinon un
 * téléphone à plat gèlerait le match pour toute la soirée, personne d'autre ne pouvant
 * reprendre.
 */
export const SCORER_STALE_MS = 30 * 60_000;

/**
 * ⚠️ On se fie à `scorerClaimedAt` SEUL, et surtout pas à `updatedAt`.
 *
 * `updatedAt` est un `@updatedAt` : n'importe quelle écriture sur la ligne le rafraîchit, y
 * compris celle d'un tiers — un capitaine qui corrige le nom de l'adversaire, par exemple. La
 * borne de 30 minutes n'en était alors plus une : chaque correction reconduisait indéfiniment
 * une prise morte, et le match restait inaccessible.
 *
 * `scorerClaimedAt` n'est écrit que par la prise et par les écritures du marqueur lui-même
 * (cf. `PUT …/live`), c'est donc bien l'horodatage de sa dernière activité.
 */
export function scorerIsStale(claimedAt: Date | null, now: Date = new Date()): boolean {
  if (!claimedAt) return true;
  return now.getTime() - claimedAt.getTime() > SCORER_STALE_MS;
}

/** Instantané du match en cours, tel que le marqueur l'envoie. Toléré partiel : il vient du client. */
export interface LiveSnapshot {
  current: { home: number; away: number };
  serving: Side | null;
  servingBox: "right" | "left" | null;
  awaitingServeBox: boolean;
}

/**
 * Borne HAUTE des points d'un instantané.
 *
 * Ce n'est pas une règle du squash — un jeu à l'avantage n'a pas de plafond théorique — mais
 * une borne de ce qui peut être AFFICHÉ. Aucun jeu réel n'approche cette valeur, et au-delà on
 * ne regarde plus un score mais une erreur de client ou un abus.
 *
 * Elle manquait, alors que `PUT …/live` affirme noir sur blanc que ce qui entre en base est
 * « borné et normalisé » parce qu'il passe par ce lecteur. « Normalisé » était vrai ;
 * « borné » ne l'était pas. Le modèle n'ayant qu'un seul rôle, n'importe quel membre connecté
 * pouvait poster `{ current: { home: 1e15 } }` sur un simple que personne ne tenait, et cette
 * valeur était stockée, mise en cache, puis servie à TOUS les spectateurs jusqu'à l'écriture
 * suivante.
 */
const MAX_LIVE_POINTS = 99;

/**
 * Relit `liveJson`. Tolérant par construction : la colonne peut porter une version plus
 * ancienne du format, ou un JSON tronqué. En cas de doute on renvoie `null` — l'affichage
 * retombe alors sur les jeux terminés, jamais sur un état inventé.
 *
 * On REFUSE plutôt qu'on ne ramène dans les bornes : ramener inventerait un score, et c'est
 * précisément ce que la ligne ci-dessus promet de ne jamais faire. Côté écriture, ce `null`
 * devient un 400 (cf. `PUT …/live`), donc la valeur n'entre pas en base ; côté lecture, il fait
 * retomber l'affichage sur les jeux terminés.
 */
export function parseLive(raw: string | null): LiveSnapshot | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const cur = o.current as Record<string, unknown> | undefined;
    const home = Number(cur?.home);
    const away = Number(cur?.away);
    if (!Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0) return null;
    if (home > MAX_LIVE_POINTS || away > MAX_LIVE_POINTS) return null;
    const serving = o.serving === "home" || o.serving === "away" ? o.serving : null;
    const box = o.servingBox === "right" || o.servingBox === "left" ? o.servingBox : null;
    return { current: { home, away }, serving, servingBox: box, awaitingServeBox: !!o.awaitingServeBox };
  } catch {
    return null;
  }
}

/**
 * Sérialise un instantané pour la colonne `liveJson`. Prend un `LiveSnapshot` et non un
 * `MatchState` complet : un `MatchState` le satisfait structurellement, et n'accepter que les
 * quatre champs réellement stockés évite qu'un jour on y sérialise tout l'état du moteur.
 */
export function serializeLive(snap: LiveSnapshot): string {
  return JSON.stringify({
    current: snap.current,
    serving: snap.serving,
    servingBox: snap.servingBox,
    awaitingServeBox: snap.awaitingServeBox,
  } satisfies LiveSnapshot);
}

/**
 * Score de la RENCONTRE = nombre de matchs gagnés de chaque côté.
 *
 * ⚠️ Un match ne compte que s'il est TERMINÉ (`status === "done"`). Se fier à
 * `gamesHome !== null` serait faux : cette colonne est renseignée dès le PREMIER jeu joué, si
 * bien qu'un match mené 1-0 en plein milieu serait compté comme gagné. Une rencontre où les
 * quatre matchs ont joué un jeu afficherait 3-1 alors que rien n'est joué.
 */
export function fixtureScore(
  matches: { gamesHome: number | null; gamesAway: number | null; status: string }[],
): { home: number; away: number } {
  let home = 0;
  let away = 0;
  for (const m of matches) {
    if (m.status !== "done" || m.gamesHome === null || m.gamesAway === null) continue;
    if (m.gamesHome > m.gamesAway) home += 1;
    else if (m.gamesAway > m.gamesHome) away += 1;
  }
  return { home, away };
}

/**
 * Statut DÉDUIT de la rencontre, indépendamment de la colonne `status` : tous les matchs sont
 * terminés ⇒ terminée ; au moins un match entamé ⇒ en cours. La colonne reste la valeur
 * stockée, mais l'API la recale (auto-cicatrisation, comme le tournoi).
 *
 * ⚠️ « Terminé » se lit sur `status`, JAMAIS sur `gamesHome !== null` : cette colonne est
 * écrite dès le premier jeu. Un soir à deux terrains où les quatre matchs ont joué un jeu, la
 * rencontre aurait été déclarée terminée — le direct se serait figé et la notification de
 * résultat serait partie à tous les abonnés, en plein milieu de la soirée.
 */
export function derivedStatus(
  matchCount: number,
  matches: { gamesHome: number | null; status: string }[],
): "scheduled" | "live" | "done" {
  const done = matches.filter((m) => m.status === "done").length;
  if (done >= matchCount && matchCount > 0) return "done";
  const started = matches.some((m) => m.status === "live" || m.status === "done" || m.gamesHome !== null);
  return started ? "live" : "scheduled";
}

/**
 * Comment la LIGUE compte cette rencontre.
 *
 * À quatre simples, le 2-2 est possible — c'est nouveau pour nous : la division 4 se jouait en
 * CINQ matchs jusqu'en 2025-26, où un nul était arithmétiquement hors d'atteinte. Le barème de
 * la ligue Île-de-France, vérifié en recalculant les dix-sept rencontres nulles du critérium
 * 2025-26 contre le classement officiel :
 *
 *   victoire 3 pts · NUL GAGNÉ (E+) 2 pts · NUL PERDU (E-) 1 pt · défaite 0
 *
 * et le départage d'un nul se fait à l'average de JEUX, puis — à jeux égaux seulement — à
 * l'average de POINTS. L'ordre n'est pas indifférent : sur CLOUD1–PUC1, les jeux donnaient
 * l'un (9-8) et les points l'autre (153-161), et c'est bien le gagnant aux jeux qui a reçu les
 * deux points au classement.
 *
 * ⚠️ Les points de jeu ne sont rendus que si le détail est COMPLET — un seul match saisi en
 * « 3-1 » sans son jeu par jeu, et la somme serait un total partiel présenté comme un total.
 * C'est précisément le chiffre qui départage : faux, il désignerait le mauvais vainqueur.
 */
export type TieResult = "win" | "loss" | "drawWon" | "drawLost" | "drawUnbroken";

export type TieOutcome = {
  result: TieResult;
  /** Points de classement. NULL quand rien ne départage — on ne les invente pas. */
  leaguePoints: number | null;
  /** Matchs gagnés, jeux gagnés, et points de jeu cumulés (NULL si le détail manque). */
  matches: { home: number; away: number };
  games: { home: number; away: number };
  rallies: { home: number; away: number } | null;
  /** Ce qui a tranché, pour que l'écran puisse le montrer plutôt que de le laisser deviner. */
  decidedBy: "matches" | "games" | "rallies" | null;
};

export function tieOutcome(
  matchCount: number,
  matches: {
    gamesHome: number | null;
    gamesAway: number | null;
    status: string;
    games?: { home: number; away: number }[];
  }[],
): TieOutcome | null {
  // Une rencontre pas finie n'a pas de résultat. Le dire à mi-parcours ferait passer un 2-1
  // en cours pour une victoire acquise.
  if (derivedStatus(matchCount, matches) !== "done") return null;

  const joues = matches.filter(
    (m) => m.status === "done" && m.gamesHome !== null && m.gamesAway !== null,
  );
  const mScore = fixtureScore(matches);

  let jeuxH = 0;
  let jeuxA = 0;
  for (const m of joues) {
    jeuxH += m.gamesHome as number;
    jeuxA += m.gamesAway as number;
  }

  let ptsH = 0;
  let ptsA = 0;
  let complet = true;
  for (const m of joues) {
    const jeux = m.games ?? [];
    // Le nombre de jeux DÉTAILLÉS doit égaler le nombre de jeux joués : c'est la seule
    // vérification qui distingue « tout est saisi » de « il en manque un ».
    if (jeux.length !== (m.gamesHome as number) + (m.gamesAway as number)) {
      complet = false;
      break;
    }
    for (const j of jeux) {
      ptsH += j.home;
      ptsA += j.away;
    }
  }
  const rallies = complet ? { home: ptsH, away: ptsA } : null;

  const base = { matches: mScore, games: { home: jeuxH, away: jeuxA }, rallies };
  if (mScore.home > mScore.away) {
    return { ...base, result: "win", leaguePoints: 3, decidedBy: "matches" };
  }
  if (mScore.away > mScore.home) {
    return { ...base, result: "loss", leaguePoints: 0, decidedBy: "matches" };
  }
  if (jeuxH !== jeuxA) {
    const gagne = jeuxH > jeuxA;
    return {
      ...base,
      result: gagne ? "drawWon" : "drawLost",
      leaguePoints: gagne ? 2 : 1,
      decidedBy: "games",
    };
  }
  if (rallies && rallies.home !== rallies.away) {
    const gagne = rallies.home > rallies.away;
    return {
      ...base,
      result: gagne ? "drawWon" : "drawLost",
      leaguePoints: gagne ? 2 : 1,
      decidedBy: "rallies",
    };
  }
  // Jeux égaux et points égaux (ou points indisponibles) : la ligue tranchera, pas nous.
  return { ...base, result: "drawUnbroken", leaguePoints: null, decidedBy: null };
}

/** Vue envoyée au client. Ne contient que du déjà-public : noms d'affichage, scores, couleurs. */
export function serializeInterclub(f: FullInterclub, userId: string | null, isAdmin = false) {
  const matches = f.matches.map((m) => {
    const live = m.status === "live" ? parseLive(m.liveJson) : null;
    return {
      id: m.id,
      order: m.order,
      homeUserId: m.homeUserId,
      // Un simple porte un membre OU un invité (joueur d'équipe sans compte) : l'écran a
      // besoin des deux pour resélectionner la bonne entrée du roster à la réouverture.
      homeGuestId: m.homeGuestId,
      homeDisplayName: m.homeDisplayName,
      awayName: m.awayName,
      // Normalisé à la sortie : les lignes saisies avant le passage au choix libre portent
      // encore une clé de l'ancienne palette, le client n'a pas à connaître les deux formes.
      homeColor: normalizeColor(m.homeColor),
      awayColor: normalizeColor(m.awayColor),
      status: m.status,
      gamesHome: m.gamesHome,
      gamesAway: m.gamesAway,
      games: m.games.map((g) => ({ number: g.number, home: g.pointsHome, away: g.pointsAway })),
      live,
      scorerId: m.scorerId,
      scorerName: m.scorer ? (m.scorer.nickname ?? m.scorer.displayName) : null,
      isMine: !!userId && m.scorerId === userId,
      scorerStale: scorerIsStale(m.scorerClaimedAt),
      updatedAt: m.updatedAt.toISOString(),
    };
  });

  return {
    id: f.id,
    date: f.date,
    // Heure, lieu et journée de championnat : tout ce qui fait qu'une rencontre est un
    // RENDEZ-VOUS et pas seulement une ligne de résultat. Nullables — une rencontre inscrite
    // avant la publication du calendrier n'en sait rien encore.
    time: f.time,
    venue: f.venue,
    venueAddress: f.venueAddress,
    round: f.round,
    // Faux = date prévisionnelle (la fédération publie les journées non planifiées avec une
    // date bouchon commune). L'écran doit le DIRE : afficher une date qu'on sait fausse comme
    // une date ferme est ce qui ferait déplacer quelqu'un pour rien.
    dateConfirmed: f.dateConfirmed,
    team: {
      id: f.team.id,
      name: f.team.name,
      captainId: f.team.captainId,
      captainName: f.team.captain ? (f.team.captain.nickname ?? f.team.captain.displayName) : null,
    },
    season: f.season,
    opponent: f.opponent,
    home: f.home,
    matchCount: f.matchCount,
    bestOf: f.bestOf,
    winGames: winGamesFor(f.bestOf),
    status: derivedStatus(f.matchCount, f.matches),
    score: fixtureScore(f.matches),
    outcome: tieOutcome(
      f.matchCount,
      f.matches.map((m) => ({
        gamesHome: m.gamesHome,
        gamesAway: m.gamesAway,
        status: m.status,
        games: m.games.map((g) => ({ home: g.pointsHome, away: g.pointsAway })),
      })),
    ),
    createdById: f.createdById,
    isCreator: !!userId && f.createdById === userId,
    // Le serveur autorise le créateur OU un admin : l'écran affiche donc le bouton dans les
    // mêmes cas, plutôt que de le cacher à un admin qui a pourtant le droit.
    canDelete: (!!userId && f.createdById === userId) || isAdmin,
    matches,
  };
}

/** Un jeu tel que la base le porte, réduit à ce que la garde de fraîcheur regarde. */
export type StoredGame = { pointsHome: number; pointsAway: number };

/**
 * GARDE DE FRAÎCHEUR DES JEUX — écrite UNE fois, appliquée par les deux routes d'écriture.
 *
 * Elle protège d'un journal calculé sur un état que la base a dépassé. Le danger est le même
 * des deux côtés : `games` REMPLACE intégralement la liste, donc un corps périmé efface.
 *
 * Elle vivait pourtant en double, et les deux copies avaient divergé — `docs/interclub.md`
 * affirmait que la garde couvrait « les deux routes » alors que le `PATCH` n'en appliquait
 * qu'une moitié. Deux exemplaires d'une règle finissent toujours par ne plus dire la même
 * chose ; celui-ci est le seul.
 *
 * Trois refus, et un seul message par famille :
 *
 * 1. RETIRER SANS RIEN ANNONCER. Le champ reste facultatif — c'est le chemin du marqueur point
 *    par point, qui ne fait que croître — mais il devient obligatoire pour raccourcir la liste.
 *    Sans cette clause, un corps minimal `{ games: [] }` que n'importe quel membre peut poster
 *    efface toutes les lignes et annule le score : rien ne distingue « je n'ai encore rien à
 *    dire » de « efface tout ».
 *
 * 2. UN AUTRE NOMBRE DE JEUX. Le compte annoncé est celui que le serveur avait CONFIRMÉ, pas
 *    celui qu'on envoie maintenant : un undo qui défait un jeu gagnant raccourcit le second
 *    sans toucher au premier, et reste donc légal.
 *
 * 3. LE MÊME NOMBRE, UN AUTRE SCORE. C'est le trou que la comparaison de longueurs laissait
 *    ouvert, et il se referme sur une correction ordinaire : le marqueur compte deux jeux puis
 *    fait « Retour » (son journal local reste) ; le capitaine corrige une faute de frappe du
 *    premier jeu — deux jeux avant, deux après ; le marqueur rouvre et son premier point
 *    renvoie l'ANCIEN premier jeu, avec un compte qui tombe juste. La correction disparaissait
 *    sans erreur ni trace. « Même nombre » ne veut pas dire « personne n'a écrit ».
 *
 * La comparaison porte sur le PRÉFIXE COMMUN, jamais sur toute la liste annoncée : après un
 * undo, `envoye` est plus court que `known`, et exiger la présence des jeux manquants
 * interdirait précisément l'undo que la règle 2 prend soin d'autoriser.
 */
export function staleGamesReason(
  known: number | undefined,
  base: readonly StoredGame[],
  envoye: readonly GameScore[],
): string | null {
  if (known === undefined) {
    return envoye.length < base.length
      ? "Retirer des jeux demande de dire sur quel score on se fonde"
      : null;
  }
  if (known !== base.length) return "Le score a changé ailleurs — le marquage repart du score enregistré";
  const commun = Math.min(known, envoye.length);
  for (let i = 0; i < commun; i++) {
    if (base[i].pointsHome !== envoye[i].home || base[i].pointsAway !== envoye[i].away) {
      return "Le score a changé ailleurs — le marquage repart du score enregistré";
    }
  }
  return null;
}
