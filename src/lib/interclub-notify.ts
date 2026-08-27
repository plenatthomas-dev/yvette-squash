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
      // d'empiler la soirée entière sur l'écran verrouillé.
      tag: `interclub-${ctx.fixtureId}`,
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

/** La rencontre est terminée — tous les niveaux, y compris « résultat seul ». */
export function notifyFixtureDone(
  ctx: Ctx,
  score: { home: number; away: number },
): Promise<void> {
  const verdict =
    score.home > score.away ? "l'emporte" : score.home < score.away ? "s'incline" : "fait match nul";
  return send(
    ctx,
    "result",
    `${ctx.teamName} – ${ctx.opponent}`,
    `Rencontre terminée : ${ctx.teamName} ${verdict} ${score.home}-${score.away}.`,
  );
}

/** Le premier point vient d'être marqué — niveau « temps forts ». */
export function notifyFixtureStart(ctx: Ctx): Promise<void> {
  return send(
    ctx,
    "highlights",
    `${ctx.teamName} – ${ctx.opponent}`,
    "La rencontre commence.",
  );
}
