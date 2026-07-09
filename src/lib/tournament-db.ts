import {
  roundRobin,
  scheduleMatches,
  poolStandings,
  bracketLive,
  type MatchResult,
} from "@/lib/tournament";
import type { Prisma } from "@prisma/client";

// Nombre de jeux à gagner selon le format (best-of) : bo3 → 2, bo5 → 3.
export function winGames(bestOf: number): number {
  return Math.ceil(bestOf / 2);
}

// Un score { g1, g2 } est valide si UN seul camp atteint winGames et l'autre est en dessous.
export function validScore(g1: number, g2: number, bestOf: number): boolean {
  const w = winGames(bestOf);
  if (![g1, g2].every((x) => Number.isInteger(x) && x >= 0)) return false;
  return (g1 === w && g2 < w) || (g2 === w && g1 < w);
}

// Tournoi complet chargé de la base (relations incluses), tel qu'utilisé par la sérialisation.
export type FullTournament = Prisma.TournamentGetPayload<{
  include: { players: true; groups: true; matches: true };
}>;

export const tournamentInclude = {
  players: true,
  groups: true,
  matches: true,
} satisfies Prisma.TournamentInclude;

/** Clé « moteur » d'un match de tableau à partir de ses champs DB (branch-round-slot). */
function bracketKey(m: { branch: string | null; round: number | null; slot: number | null }): string {
  return `${m.branch}-${m.round}-${m.slot}`;
}

/**
 * Sérialise un tournoi pour l'API : joueurs, poules + classements, ou tableau « en direct »
 * (participants courants + classement final), plus la liste des matchs planifiés (terrains).
 * La logique de classement/tableau vient du moteur pur ; ici on ne fait que brancher la base.
 */
export function serializeTournament(t: FullTournament, userId: string) {
  const players = [...t.players].sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0));
  const nameById = new Map(players.map((p) => [p.id, p.displayName]));
  const seedById = new Map(players.map((p) => [p.id, p.seed ?? 0]));
  const idBySeed = new Map(players.map((p) => [p.seed ?? 0, p.id]));
  const n = players.length;
  const name = (id: string | null) => (id ? (nameById.get(id) ?? "?") : "?");
  const playerRef = (id: string | null) => (id ? { id, name: name(id) } : null);

  const isCreator = t.createdById === userId;
  const isParticipant = players.some((p) => p.userId === userId);

  const base = {
    id: t.id,
    name: t.name,
    date: t.date,
    status: t.status,
    format: t.format,
    targetMatches: t.targetMatches,
    bestOf: t.bestOf,
    courts: t.courts,
    isCreator,
    isParticipant,
    players: players.map((p) => ({ id: p.id, name: p.displayName, seed: p.seed ?? 0 })),
  };

  const terrain = (court: number) => `Terrain ${court + 1}`;

  if (t.format === "pools") {
    const poolMatches = t.matches.filter((m) => m.phase === "pool");
    // Planning des terrains sur l'ensemble des matchs de poules.
    const sched = scheduleMatches(
      poolMatches
        .filter((m) => m.player1Id && m.player2Id)
        .map((m) => ({ key: m.id, p1: m.player1Id as string, p2: m.player2Id as string })),
      t.courts,
    );
    const schedById = new Map(sched.map((s) => [s.key, s]));

    const pools = t.groups
      .map((g) => {
        const gMatches = poolMatches.filter((m) => m.groupId === g.id);
        const gPlayers = players.filter((p) => p.groupId === g.id);
        const results: MatchResult[] = gMatches
          .filter((m) => m.status === "done" && m.player1Id && m.player2Id)
          .map((m) => ({
            p1: m.player1Id as string,
            p2: m.player2Id as string,
            games1: m.score1 ?? 0,
            games2: m.score2 ?? 0,
          }));
        const standings = poolStandings(
          gPlayers.map((p) => p.id),
          results,
        ).map((s) => ({ ...s, name: name(s.playerId) }));
        return {
          label: g.label,
          matches: gMatches
            .map((m) => ({
              id: m.id,
              p1: playerRef(m.player1Id),
              p2: playerRef(m.player2Id),
              score1: m.score1,
              score2: m.score2,
              winnerId: m.winnerId,
              status: m.status,
              terrain: schedById.has(m.id) ? terrain(schedById.get(m.id)!.court) : null,
              order: schedById.get(m.id)?.order ?? null,
            }))
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
          standings,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));

    const allDone = poolMatches.length > 0 && poolMatches.every((m) => m.status === "done");
    // Champion = 1er de l'unique poule si une seule (round-robin intégral) ; sinon aucun.
    const champion =
      allDone && pools.length === 1 && pools[0].standings[0]
        ? { id: pools[0].standings[0].playerId, name: pools[0].standings[0].name }
        : null;

    return { ...base, pools, bracket: null, champion };
  }

  // --- Format tableau (bracket) ---
  const bracketMatches = t.matches.filter((m) => m.phase !== "pool");
  const dbByKey = new Map(bracketMatches.map((m) => [bracketKey(m), m]));
  const winnerSeedByKey = (key: string): number | null => {
    const m = dbByKey.get(key);
    if (!m || m.status !== "done" || !m.winnerId) return null;
    return seedById.get(m.winnerId) ?? null;
  };
  const live = bracketLive(n, winnerSeedByKey);

  // Planning : par tour, on planifie les matchs jouables (deux participants connus).
  let orderCursor = 0;
  const schedById = new Map<string, { court: number; order: number }>();
  for (let r = 0; r < live.rounds; r++) {
    const playable = live.matches.filter(
      (m) => m.round === r && m.status !== "bye" && m.p1 !== null && m.p2 !== null,
    );
    const sched = scheduleMatches(
      playable.map((m) => ({ key: m.key, p1: String(m.p1), p2: String(m.p2) })),
      t.courts,
    );
    for (const s of sched.sort((a, b) => a.order - b.order)) {
      schedById.set(s.key, { court: s.court, order: orderCursor++ });
    }
  }

  const matches = live.matches
    .map((lm) => {
      const db = dbByKey.get(lm.key);
      const p1Id = lm.p1 !== null ? (idBySeed.get(lm.p1) ?? null) : null;
      const p2Id = lm.p2 !== null ? (idBySeed.get(lm.p2) ?? null) : null;
      const s = schedById.get(lm.key);
      return {
        id: db?.id ?? null,
        round: lm.round,
        slot: lm.slot,
        branch: lm.branch,
        phase: lm.phase,
        placeLabel: lm.placeLabel ?? null,
        p1: playerRef(p1Id),
        p2: playerRef(p2Id),
        score1: db?.score1 ?? null,
        score2: db?.score2 ?? null,
        winnerId: db?.winnerId ?? null,
        status: lm.status,
        terrain: s ? terrain(s.court) : null,
        order: s?.order ?? null,
      };
    })
    .sort((a, b) => a.round - b.round || a.slot - b.slot);

  const ranking =
    live.ranking?.map((r) => ({
      playerId: idBySeed.get(r.seed) as string,
      name: name(idBySeed.get(r.seed) ?? null),
      rank: r.rank,
    })) ?? null;
  const champion = ranking ? { id: ranking[0].playerId, name: ranking[0].name } : null;

  return {
    ...base,
    pools: null,
    bracket: { rounds: live.rounds, byes: live.byes, ranking, matches },
    champion,
  };
}

/**
 * Matérialise la formule choisie : crée les poules + matchs (poules) ou tous les matchs du
 * tableau (byes déjà résolus). À appeler dans une transaction. `players` est trié par seed.
 */
export async function materialize(
  tx: Prisma.TransactionClient,
  tournamentId: string,
  format: "pools" | "bracket",
  players: { id: string; seed: number }[],
  poolSizes: number[],
): Promise<void> {
  const idBySeed = new Map(players.map((p) => [p.seed, p.id]));
  const n = players.length;

  if (format === "pools") {
    // Remplissage séquentiel des poules par seed (A, B, C…).
    let cursor = 0;
    for (let gi = 0; gi < poolSizes.length; gi++) {
      const label = String.fromCharCode(65 + gi); // A, B, C…
      const group = await tx.tournamentGroup.create({
        data: { tournamentId, label },
      });
      const localIds: string[] = [];
      for (let k = 0; k < poolSizes[gi]; k++) {
        const pid = players[cursor++].id;
        localIds.push(pid);
        await tx.tournamentPlayer.update({ where: { id: pid }, data: { groupId: group.id } });
      }
      // Round-robin de la poule.
      for (const round of roundRobin(localIds.map((_, i) => i))) {
        for (const [i, j] of round) {
          await tx.match.create({
            data: {
              tournamentId,
              phase: "pool",
              groupId: group.id,
              player1Id: localIds[i],
              player2Id: localIds[j],
              status: "pending",
            },
          });
        }
      }
    }
    return;
  }

  // Tableau : on crée un Match par match structurel (byes déjà résolus par bracketLive).
  const live = bracketLive(n, () => null);
  for (const m of live.matches) {
    const p1Id = m.p1 !== null ? (idBySeed.get(m.p1) ?? null) : null;
    const p2Id = m.p2 !== null ? (idBySeed.get(m.p2) ?? null) : null;
    const winnerId = m.status === "bye" && m.winnerSeed !== null ? (idBySeed.get(m.winnerSeed) ?? null) : null;
    await tx.match.create({
      data: {
        tournamentId,
        phase: m.phase,
        round: m.round,
        slot: m.slot,
        branch: m.branch,
        placeLabel: m.placeLabel ?? null,
        player1Id: p1Id,
        player2Id: p2Id,
        status: m.status === "bye" ? "bye" : "pending",
        winnerId,
      },
    });
  }
}
