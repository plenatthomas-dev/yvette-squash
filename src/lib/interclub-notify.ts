// Notifications du suivi interclub.
//
// LE VRAI SUJET EST LE DOSAGE, pas la technique. Une notification par échange, c'est ~200 par
// match et ~800 par soirée : personne ne garde ça activé plus d'une semaine, et une fonction
// qu'on désactive ne sert plus jamais. D'où trois paliers d'abonnement, aucun par défaut, et
// un `tag` unique par rencontre pour que l'écran verrouillé n'accumule jamais plus d'une ligne.

import { prisma } from "./db";
import { pushToUsers } from "./push";
import { FOLLOW_LEVELS, type FollowLevel } from "./interclub";

/**
 * Les abonnés d'une équipe dont le niveau couvre `want`.
 *
 * Le filtre se fait EN BASE sur les niveaux concernés plutôt qu'en mémoire : c'est l'index
 * ([teamId, level]) qui porte cette requête, et c'est la raison d'être de la table.
 */
async function followersFor(teamId: string, want: FollowLevel): Promise<string[]> {
  const covering = FOLLOW_LEVELS.slice(FOLLOW_LEVELS.indexOf(want));
  const rows = await prisma.interclubFollow.findMany({
    where: { teamId, level: { in: [...covering] } },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

interface Ctx {
  fixtureId: string;
  teamId: string;
  teamName: string;
  opponent: string;
}

/**
 * Envoi best-effort : une notification perdue ne doit jamais faire échouer la saisie d'un
 * score. `pushToUsers` ne jette pas, on ajoute une ceinture au cas où la requête, elle, jette.
 */
async function send(ctx: Ctx, want: FollowLevel, title: string, body: string): Promise<void> {
  try {
    const ids = await followersFor(ctx.teamId, want);
    if (ids.length === 0) return;
    await pushToUsers(ids, {
      title,
      body,
      url: "/?view=interclub",
      // Un tag par RENCONTRE : la nouvelle notification remplace la précédente au lieu
      // d'empiler la soirée entière sur l'écran verrouillé. Deux rencontres le même soir
      // (équipe 1 et équipe 2) ont donc deux tags, donc deux lignes distinctes.
      tag: `interclub-${ctx.fixtureId}`,
      // …mais on veut être ENTENDU à chaque fois : sans ceci, le remplacement serait
      // silencieux et seul le premier événement de la soirée alerterait.
      renotify: true,
    });
  } catch {
    /* best-effort */
  }
}

/** Un jeu vient de se terminer — niveau « détaillé » seulement. */
export function notifyGameDone(
  ctx: Ctx,
  player: string,
  opponentName: string,
  games: { home: number; away: number }[],
): Promise<void> {
  const last = games[games.length - 1];
  const won = games.reduce(
    (acc, g) => ({
      home: acc.home + (g.home > g.away ? 1 : 0),
      away: acc.away + (g.away > g.home ? 1 : 0),
    }),
    { home: 0, away: 0 },
  );
  return send(
    ctx,
    "detailed",
    `${ctx.teamName} – ${ctx.opponent}`,
    `${player} c. ${opponentName} : ${last.home}-${last.away} (${won.home}-${won.away} en jeux)`,
  );
}

/** Un match est gagné — niveau « temps forts ». */
export function notifyMatchDone(
  ctx: Ctx,
  player: string,
  opponentName: string,
  gamesHome: number,
  gamesAway: number,
  fixtureScore: { home: number; away: number },
): Promise<void> {
  const verdict = gamesHome > gamesAway ? "gagne" : "perd";
  return send(
    ctx,
    "highlights",
    `${ctx.teamName} – ${ctx.opponent}`,
    `${player} ${verdict} ${gamesHome}-${gamesAway} contre ${opponentName}. Rencontre : ${fixtureScore.home}-${fixtureScore.away}.`,
  );
}

/** Un simple, tel qu'on le résume dans la notification de fin de rencontre. */
export interface MatchLine {
  player: string;
  gamesHome: number | null;
  gamesAway: number | null;
}

/**
 * Longueur maximale du corps, alignée sur l'annonce admin. Au-delà, les systèmes tronquent
 * eux-mêmes, et souvent au milieu d'un nom — mieux vaut couper nous-mêmes, proprement.
 */
const MAX_BODY = 300;

/** « Tom 3-0, Marc 1-3 » — les matchs sans résultat sont passés sous silence. */
function summarize(lines: readonly MatchLine[]): string {
  return lines
    .filter((l) => l.gamesHome !== null && l.gamesAway !== null)
    .map((l) => `${l.player} ${l.gamesHome}-${l.gamesAway}`)
    .join(", ");
}

/**
 * La rencontre est terminée — tous les niveaux, y compris « résultat seul ».
 *
 * C'est LA notification que reçoivent ceux qui n'en veulent qu'une par soirée : elle doit donc
 * se suffire à elle-même, d'où le détail par joueur et pas seulement le score global.
 */
export function notifyFixtureDone(
  ctx: Ctx,
  score: { home: number; away: number },
  lines: readonly MatchLine[] = [],
): Promise<void> {
  const verdict =
    score.home > score.away ? "l'emporte" : score.home < score.away ? "s'incline" : "fait match nul";
  const detail = summarize(lines);
  const body = `${ctx.teamName} ${verdict} ${score.home}-${score.away}${detail ? ` · ${detail}` : ""}`;
  return send(ctx, "result", `${ctx.teamName} – ${ctx.opponent}`, body.slice(0, MAX_BODY));
}

/**
 * Le premier point vient d'être marqué — niveau « temps forts ». On nomme le match qui
 * démarre : « la rencontre commence » tout court n'apprend rien qu'on ne sache déjà en
 * s'étant abonné.
 */
export function notifyFixtureStart(ctx: Ctx, player?: string, opponentName?: string): Promise<void> {
  const who = player && opponentName ? ` ${player} c. ${opponentName} entre sur le court.` : "";
  return send(
    ctx,
    "highlights",
    `${ctx.teamName} – ${ctx.opponent}`,
    `La rencontre commence.${who}`.slice(0, MAX_BODY),
  );
}
