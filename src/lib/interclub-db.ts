// Colle entre la base et l'API pour l'interclub. Contrairement à `interclub.ts` (moteur pur),
// ce module connaît Prisma — il ne doit donc JAMAIS être importé depuis un composant client.

import { Prisma } from "@prisma/client";
import { normalizeColor, UNSET_PLAYER, winGamesFor, type Side } from "./interclub";

export const interclubInclude = {
  team: true,
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
export const MAX_DIVISION_LEN = 30;

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
    team: { id: f.team.id, name: f.team.name },
    season: f.season,
    division: f.division,
    opponent: f.opponent,
    home: f.home,
    matchCount: f.matchCount,
    bestOf: f.bestOf,
    winGames: winGamesFor(f.bestOf),
    status: derivedStatus(f.matchCount, f.matches),
    score: fixtureScore(f.matches),
    createdById: f.createdById,
    isCreator: !!userId && f.createdById === userId,
    // Le serveur autorise le créateur OU un admin : l'écran affiche donc le bouton dans les
    // mêmes cas, plutôt que de le cacher à un admin qui a pourtant le droit.
    canDelete: (!!userId && f.createdById === userId) || isAdmin,
    matches,
  };
}
