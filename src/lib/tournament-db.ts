import {
  roundRobin,
  scheduleMatches,
  poolStandings,
  bracketLive,
  snakeGroups,
  poolTiers,
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

type MatchRow = FullTournament["matches"][number];

/**
 * Sérialise UN tableau à repêchage (moteur `bracketLive`) vers la forme attendue par l'API :
 * participants résolus en direct, scores, planning des terrains, classement final. Réutilisé
 * par chaque TABLEAU FINAL d'un pools_bracket (un par rang de poule) — `seedToId`/`idToSeed`
 * font le lien seed local (0..k-1) ↔ joueur, `n` = nombre de joueurs réels du tableau.
 */
function serializeBracket(
  n: number,
  dbMatches: MatchRow[],
  seedToId: Map<number, string>,
  idToSeed: Map<string, number>,
  courts: number,
  name: (id: string | null) => string,
  playerRef: (id: string | null) => { id: string; name: string } | null,
) {
  const dbByKey = new Map(dbMatches.map((m) => [bracketKey(m), m]));
  const winnerSeedByKey = (key: string): number | null => {
    const m = dbByKey.get(key);
    if (!m || m.status !== "done" || !m.winnerId) return null;
    return idToSeed.get(m.winnerId) ?? null;
  };
  const live = bracketLive(n, winnerSeedByKey);

  let orderCursor = 0;
  const schedById = new Map<string, { court: number; order: number }>();
  for (let r = 0; r < live.rounds; r++) {
    const playable = live.matches.filter(
      (m) => m.round === r && m.status !== "bye" && m.p1 !== null && m.p2 !== null,
    );
    const sched = scheduleMatches(
      playable.map((m) => ({ key: m.key, p1: String(m.p1), p2: String(m.p2) })),
      courts,
    );
    for (const s of sched.sort((a, b) => a.order - b.order)) {
      schedById.set(s.key, { court: s.court, order: orderCursor++ });
    }
  }

  const winnersStage: Record<number, string> = {
    1: "Demi-finale",
    2: "Quart de finale",
    3: "8e de finale",
    4: "16e de finale",
  };
  const stageOf = (lm: (typeof live.matches)[number]): string => {
    if (lm.placeLabel) return lm.placeLabel;
    const d = live.rounds - 1 - lm.round;
    if (lm.phase === "winners") return winnersStage[d] ?? `Tour ${lm.round + 1}`;
    return "Repêchage";
  };
  const terrain = (court: number) => `Terrain ${court + 1}`;

  const matches = live.matches
    .map((lm) => {
      const db = dbByKey.get(lm.key);
      const p1Id = lm.p1 !== null ? (seedToId.get(lm.p1) ?? null) : null;
      const p2Id = lm.p2 !== null ? (seedToId.get(lm.p2) ?? null) : null;
      const s = schedById.get(lm.key);
      return {
        id: db?.id ?? null,
        round: lm.round,
        slot: lm.slot,
        branch: lm.branch,
        phase: lm.phase,
        placeLabel: lm.placeLabel ?? null,
        rankLow: lm.rankLow,
        rankHigh: lm.rankHigh,
        stage: stageOf(lm),
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

  const stat = new Map<number, { played: number; wins: number; losses: number }>();
  const bump = (seed: number | null, win: boolean) => {
    if (seed === null || seed < 0) return;
    const s = stat.get(seed) ?? { played: 0, wins: 0, losses: 0 };
    s.played++;
    if (win) s.wins++;
    else s.losses++;
    stat.set(seed, s);
  };
  for (const lm of live.matches) {
    if (lm.status !== "done" || lm.p1 === null || lm.p2 === null || lm.winnerSeed === null) continue;
    bump(lm.p1, lm.winnerSeed === lm.p1);
    bump(lm.p2, lm.winnerSeed === lm.p2);
  }
  const ranking =
    live.ranking?.map((r) => {
      const s = stat.get(r.seed) ?? { played: 0, wins: 0, losses: 0 };
      return {
        playerId: seedToId.get(r.seed) as string,
        name: name(seedToId.get(r.seed) ?? null),
        rank: r.rank,
        played: s.played,
        wins: s.wins,
        losses: s.losses,
      };
    }) ?? null;

  return { rounds: live.rounds, byes: live.byes, ranking, matches };
}

/**
 * Sérialise les TABLEAUX FINAUX d'un pools_bracket (un par rang de poule) depuis les matchs
 * `tier != null` déjà matérialisés. Reconstruit le lien seed↔joueur depuis le 1er tour stocké
 * (chaque slot du squelette porte son seed), puis délègue à `serializeBracket`.
 */
function serializeFinals(
  t: FullTournament,
  courts: number,
  name: (id: string | null) => string,
  playerRef: (id: string | null) => { id: string; name: string } | null,
) {
  const finalMatches = t.matches.filter((m) => m.tier != null);
  const tierNums = [...new Set(finalMatches.map((m) => m.tier as number))].sort((a, b) => a - b);
  const ordinal = (tier: number) => (tier === 1 ? "1ers" : `${tier}es`);
  return tierNums.map((tier) => {
    const tm = finalMatches.filter((m) => m.tier === tier);
    // k = joueurs réels = participants non nuls du 1er tour (byes = un côté null).
    const round0 = tm.filter((m) => (m.round ?? 0) === 0);
    const k = round0.reduce((acc, m) => acc + (m.player1Id ? 1 : 0) + (m.player2Id ? 1 : 0), 0);
    const dbByKey = new Map(tm.map((m) => [bracketKey(m), m]));
    const scaffold = bracketLive(k, () => null);
    const seedToId = new Map<number, string>();
    for (const lm of scaffold.matches) {
      const db = dbByKey.get(lm.key);
      if (!db) continue;
      if (lm.p1 !== null && lm.p1 >= 0 && db.player1Id) seedToId.set(lm.p1, db.player1Id);
      if (lm.p2 !== null && lm.p2 >= 0 && db.player2Id) seedToId.set(lm.p2, db.player2Id);
    }
    const idToSeed = new Map([...seedToId].map(([s, id]) => [id, s]));
    const view = serializeBracket(k, tm, seedToId, idToSeed, courts, name, playerRef);
    return { tier, title: `Tableau des ${ordinal(tier)} de poule`, ...view };
  });
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

  if (t.format === "pools" || t.format === "pools_bracket") {
    const poolMatches = t.matches.filter((m) => m.phase === "pool");
    // Planning des terrains : on ENTRELACE les poules (zip) pour qu'elles se jouent EN MÊME
    // TEMPS (≈ un terrain par poule) au lieu de finir la poule A avant la B. L'ordre
    // round-robin (méthode du cercle, à la création) espace déjà les matchs d'un même joueur.
    const perPool = t.groups.map((g) =>
      poolMatches.filter((m) => m.groupId === g.id && m.player1Id && m.player2Id),
    );
    const interleaved: typeof poolMatches = [];
    const maxLen = Math.max(0, ...perPool.map((p) => p.length));
    for (let k = 0; k < maxLen; k++) {
      for (const pool of perPool) if (pool[k]) interleaved.push(pool[k]);
    }
    const sched = scheduleMatches(
      interleaved.map((m) => ({
        key: m.id,
        p1: m.player1Id as string,
        p2: m.player2Id as string,
      })),
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
        const gCount = gMatches.length;
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
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .map((m, i) => ({ ...m, stage: `Poule ${g.label} · match ${i + 1}/${gCount}` })),
          standings,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));

    const allDone = poolMatches.length > 0 && poolMatches.every((m) => m.status === "done");

    // --- Format « poules + tableau final » : phase finale par rang de poule ---
    const isPB = t.format === "pools_bracket";
    const finalsExist = t.matches.some((m) => m.tier != null);
    const finals = isPB && finalsExist ? serializeFinals(t, t.courts, name, playerRef) : null;
    // Le créateur peut lancer la phase finale une fois TOUTES les poules jouées (et pas déjà).
    const canGenerateFinals = isPB && allDone && !finalsExist;
    const finalsDone = finals != null && finals.length > 0 && finals.every((f) => f.ranking != null);

    // Champion : poule unique (round-robin intégral) → 1er de la poule ; pools_bracket →
    // vainqueur du tableau des 1ers (tier 1) une fois joué ; sinon aucun.
    const pbChamp = finals?.find((f) => f.tier === 1)?.ranking?.[0];
    const champion = isPB
      ? pbChamp
        ? { id: pbChamp.playerId, name: pbChamp.name }
        : null
      : allDone && pools.length === 1 && pools[0].standings[0]
        ? { id: pools[0].standings[0].playerId, name: pools[0].standings[0].name }
        : null;

    // Statut effectif BIDIRECTIONNEL : une fois généré (≠ draft), il vaut « done » si tout
    // est joué, sinon « running » — y compris à la baisse (une correction en cascade peut
    // remettre des matchs « à jouer » et donc ré-ouvrir un tournoi terminé). En pools_bracket,
    // « done » exige que les tableaux FINAUX soient tous joués (les poules seules ne suffisent
    // pas).
    const status =
      t.status === "draft"
        ? "draft"
        : isPB
          ? finalsDone
            ? "done"
            : "running"
          : allDone
            ? "done"
            : "running";
    const formatLabel = isPB
      ? `Poules + tableau final · ${t.groups.length} poules`
      : pools.length === 1
        ? `1 poule de ${pools[0].standings.length}`
        : `${pools.length} poules`;
    return {
      ...base,
      status,
      formatLabel,
      pools,
      bracket: null,
      finals,
      canGenerateFinals,
      champion,
    };
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

  // Stade d'un match du tableau : « Finale / Demi-finale / Quart de finale… » côté vainqueurs,
  // le libellé de placement pour les finales de branche, « Repêchage » sinon.
  const winnersStage: Record<number, string> = {
    1: "Demi-finale",
    2: "Quart de finale",
    3: "8e de finale",
    4: "16e de finale",
  };
  const stageOf = (lm: (typeof live.matches)[number]): string => {
    if (lm.placeLabel) return lm.placeLabel;
    const d = live.rounds - 1 - lm.round; // distance à la finale
    if (lm.phase === "winners") return winnersStage[d] ?? `Tour ${lm.round + 1}`;
    return "Repêchage";
  };

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
        rankLow: lm.rankLow,
        rankHigh: lm.rankHigh,
        stage: stageOf(lm),
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

  // MJ / V / D par joueur (seed), à partir des matchs RÉELS joués du tableau (byes exclus).
  const stat = new Map<number, { played: number; wins: number; losses: number }>();
  const bump = (seed: number | null, win: boolean) => {
    if (seed === null || seed < 0) return;
    const s = stat.get(seed) ?? { played: 0, wins: 0, losses: 0 };
    s.played++;
    if (win) s.wins++;
    else s.losses++;
    stat.set(seed, s);
  };
  for (const lm of live.matches) {
    if (lm.status !== "done" || lm.p1 === null || lm.p2 === null || lm.winnerSeed === null) continue;
    bump(lm.p1, lm.winnerSeed === lm.p1);
    bump(lm.p2, lm.winnerSeed === lm.p2);
  }
  const ranking =
    live.ranking?.map((r) => {
      const s = stat.get(r.seed) ?? { played: 0, wins: 0, losses: 0 };
      return {
        playerId: idBySeed.get(r.seed) as string,
        name: name(idBySeed.get(r.seed) ?? null),
        rank: r.rank,
        played: s.played,
        wins: s.wins,
        losses: s.losses,
      };
    }) ?? null;
  const champion = ranking ? { id: ranking[0].playerId, name: ranking[0].name } : null;

  // Statut effectif bidirectionnel (cf. poules) : « done » ssi le classement est complet.
  const status = t.status === "draft" ? "draft" : ranking != null ? "done" : "running";
  return {
    ...base,
    status,
    formatLabel: `Tableau à repêchage (${n})`,
    pools: null,
    bracket: { rounds: live.rounds, byes: live.byes, ranking, matches },
    finals: null,
    canGenerateFinals: false,
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
  format: "pools" | "bracket" | "pools_bracket",
  players: { id: string; seed: number }[],
  poolSizes: number[],
): Promise<void> {
  const idBySeed = new Map(players.map((p) => [p.seed, p.id]));
  const n = players.length;

  // « pools_bracket » ne matérialise d'abord QUE les poules (comme « pools ») ; la phase
  // finale (tableaux par rang) est générée à la demande ensuite, cf. materializeFinals.
  if (format === "pools" || format === "pools_bracket") {
    // Répartition par TÊTES DE SÉRIE, méthode standard « pots + serpentin » : on découpe les
    // seeds en pots de G (Pot 1 = seeds 1..G, Pot 2 = G+1..2G…), Pot 1 réparti A→…→G, Pot 2
    // en sens INVERSE, etc. → poules équilibrées en force (le 1 tombe avec le 4, pas le 3).
    const g = poolSizes.length;
    // Serpentin (cf. snakeGroups) : index de seed par poule → identifiants joueurs.
    const buckets = snakeGroups(players.length, g).map((idx) => idx.map((i) => players[i].id));

    for (let gi = 0; gi < g; gi++) {
      const label = String.fromCharCode(65 + gi); // A, B, C…
      const group = await tx.tournamentGroup.create({ data: { tournamentId, label } });
      const localIds = buckets[gi];
      for (const pid of localIds) {
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

/**
 * Matérialise la PHASE FINALE d'un pools_bracket : un tableau (élimination + petite finale)
 * par rang de poule (1ers ensemble, 2es ensemble…), à partir des classements de poules FIGÉS.
 * À appeler dans une transaction, une fois toutes les poules terminées. Renvoie le nb de tiers.
 */
export async function materializeFinals(
  tx: Prisma.TransactionClient,
  tournamentId: string,
): Promise<number> {
  const t = await tx.tournament.findUnique({
    where: { id: tournamentId },
    include: tournamentInclude,
  });
  if (!t) throw new Error("Tournoi introuvable");
  if (t.format !== "pools_bracket") throw new Error("Format sans phase finale");
  const poolMatches = t.matches.filter((m) => m.phase === "pool");
  if (poolMatches.length === 0 || !poolMatches.every((m) => m.status === "done")) {
    throw new Error("Toutes les poules ne sont pas terminées");
  }
  if (t.matches.some((m) => m.tier != null)) throw new Error("Phase finale déjà générée");

  // Classements de poules FIGÉS → tiers (le r-ème de chaque poule ensemble).
  const poolsRanked: string[][] = t.groups.map((g) => {
    const gPlayers = t.players.filter((p) => p.groupId === g.id);
    const results: MatchResult[] = t.matches
      .filter((m) => m.groupId === g.id && m.status === "done" && m.player1Id && m.player2Id)
      .map((m) => ({
        p1: m.player1Id as string,
        p2: m.player2Id as string,
        games1: m.score1 ?? 0,
        games2: m.score2 ?? 0,
      }));
    return poolStandings(
      gPlayers.map((p) => p.id),
      results,
    ).map((s) => s.playerId);
  });
  const tiers = poolTiers(poolsRanked);

  for (const { tier, playerIds } of tiers) {
    const k = playerIds.length;
    const idBySeed = new Map(playerIds.map((id, i) => [i, id])); // seed = ordre des poules
    // Squelette du tableau du tier (byes résolus) : participants du 1er tour connus.
    const live = bracketLive(k, () => null);
    for (const m of live.matches) {
      const p1Id = m.p1 !== null && m.p1 >= 0 ? (idBySeed.get(m.p1) ?? null) : null;
      const p2Id = m.p2 !== null && m.p2 >= 0 ? (idBySeed.get(m.p2) ?? null) : null;
      const winnerId =
        m.status === "bye" && m.winnerSeed !== null && m.winnerSeed >= 0
          ? (idBySeed.get(m.winnerSeed) ?? null)
          : null;
      await tx.match.create({
        data: {
          tournamentId,
          tier,
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
  return tiers.length;
}
