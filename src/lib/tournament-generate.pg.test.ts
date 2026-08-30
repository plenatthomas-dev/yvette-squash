// GÉNÉRER UN TOURNOI DEUX FOIS — les deux routes qui matérialisent, sous vraie concurrence.
//
// `generate` et `finals` ont toutes deux la même forme : LIRE un état, décider qu'il n'y a rien
// encore, puis ÉCRIRE. C'est un lire-puis-écrire, et il n'est pas sérialisable :
//
//   * `generate` lit `status !== "draft"` → 409, PUIS matérialise dans un `prisma.$transaction`
//     ordinaire (Read Committed) — la lecture est même en dehors de la transaction ;
//   * `finals` fait vérifier « phase finale déjà générée » par `materializeFinals`, à
//     l'intérieur d'une transaction ordinaire elle aussi.
//
// Deux clics au même instant — double soumission, deux onglets, le créateur sur son téléphone
// et sur le PC du club — lisent donc tous deux « pas encore généré » et matérialisent tous
// deux. Et `Match` n'a AUCUNE contrainte d'unicité sur (tournamentId, tier, branch, round,
// slot) : rien en base ne rattrape le doublon. Le tournoi part alors avec ses poules en double,
// chaque joueur voit ses matchs deux fois, et les classements comptent tout deux fois.
//
// Aucun test ne le vérifiait, et aucun ne POUVAIT le vérifier : le faux client des tests
// unitaires exécute la callback de `$transaction` directement, donc il ne connaît ni
// l'isolation ni l'entrelacement. Il faut une vraie base.
//
// ⚠️ CE FICHIER IMPORTE LES ROUTES, il ne les recopie pas. Reproduire leur corps prouverait
// que Postgres sait sérialiser, jamais que les routes s'en servent.
//
// Le préambule (garde-fou de base jetable, mode d'emploi du conteneur) vit dans `pg-harness.ts`.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { SANS_BASE, ouvrirBaseDeTest } from "./pg-harness";
import type { NextRequest } from "next/server";

// La session se déduit du COOKIE. Les routes suspendent sur `getFeatures()` AVANT de la lire :
// un objet partagé réassigné avant chaque appel serait déjà écrasé quand la route le lit, et
// deux appels lancés en parallèle porteraient le même membre.
vi.mock("@/lib/session", () => ({
  getSession: vi.fn(async (sid: string) => ({ userId: sid, displayName: sid, resa: {} })),
}));
vi.mock("@/lib/features-server", () => ({ getFeatures: async () => ({ tournament: true }) }));

type Prisma = import("@prisma/client").PrismaClient;

let prisma: Prisma;
let generate: typeof import("@/app/api/tournaments/[id]/generate/route").POST;
let finals: typeof import("@/app/api/tournaments/[id]/finals/route").POST;

const MARQUEUR = "PG-TEST-tournament-generate";
let createur = "";
let tournoiId = "";

const req = (userId: string, body: unknown = {}) =>
  ({
    cookies: { get: () => ({ value: userId }) },
    json: async () => body,
  }) as unknown as NextRequest;

const params = () => ({ params: Promise.resolve({ id: tournoiId }) });

/** Un tournoi en brouillon de 8 joueurs (invités : rien à créer côté User), seeds 0..7. */
async function nouveauBrouillon(format: "pools" | "pools_bracket"): Promise<string> {
  const t = await prisma.tournament.create({
    data: {
      name: MARQUEUR,
      date: "2026-11-14",
      createdById: createur,
      status: "draft",
      format,
      targetMatches: 3,
      bestOf: 3,
      courts: 2,
      players: {
        create: Array.from({ length: 8 }, (_, i) => ({
          guestName: `J${i + 1}`,
          displayName: `J${i + 1}`,
          seed: i,
        })),
      },
    },
  });
  return t.id;
}

/** Ce que la base contient réellement pour ce tournoi. */
async function enBase() {
  const [groupes, matchs, finaux, t] = await Promise.all([
    prisma.tournamentGroup.count({ where: { tournamentId: tournoiId } }),
    prisma.match.count({ where: { tournamentId: tournoiId, phase: "pool" } }),
    prisma.match.count({ where: { tournamentId: tournoiId, tier: { not: null } } }),
    prisma.tournament.findUnique({ where: { id: tournoiId }, select: { status: true } }),
  ]);
  return { groupes, matchs, finaux, statut: t?.status };
}

/** Joue toutes les poules (2-0 pour le joueur 1) — préalable à la phase finale. */
async function joueLesPoules() {
  const matchs = await prisma.match.findMany({
    where: { tournamentId: tournoiId, phase: "pool" },
    select: { id: true, player1Id: true },
  });
  for (const m of matchs) {
    await prisma.match.update({
      where: { id: m.id },
      data: { score1: 2, score2: 0, winnerId: m.player1Id, status: "done" },
    });
  }
}

describe.skipIf(SANS_BASE)("SUR VRAIE BASE — matérialiser un tournoi", () => {
  beforeAll(async () => {
    prisma = await ouvrirBaseDeTest();
    ({ POST: generate } = await import("@/app/api/tournaments/[id]/generate/route"));
    ({ POST: finals } = await import("@/app/api/tournaments/[id]/finals/route"));

    const u = await prisma.user.create({ data: { displayName: `${MARQUEUR} créateur` } });
    createur = u.id;
  }, 60_000);

  afterEachNettoie();

  afterAll(async () => {
    await prisma.tournament.deleteMany({ where: { name: MARQUEUR } });
    await prisma.user.deleteMany({ where: { id: createur } });
    await prisma.$disconnect();
  });

  it("DEUX générations simultanées ne créent qu'UN seul jeu de poules — dix fois de suite", async () => {
    // 8 joueurs en 2 poules de 4 : 2 groupes, et C(4,2)×2 = 12 matchs. Exactement. Un doublon
    // se verrait à 4 groupes et 24 matchs — et personne ne s'en apercevrait avant que les
    // joueurs ne voient leur soirée affichée en double.
    for (let tour = 1; tour <= 10; tour++) {
      tournoiId = await nouveauBrouillon("pools");
      const corps = { kind: "pools", poolSizes: [4, 4] };

      const [ra, rb] = await Promise.all([
        generate(req(createur, corps), params()),
        generate(req(createur, corps), params()),
      ]);
      const statuts = [ra.status, rb.status].sort();

      // L'invariant qui compte d'abord : ce que la base contient. On l'assertit AVANT les codes
      // de retour, pour que l'échec dise les vrais chiffres (4 groupes, 24 matchs…) plutôt que
      // « 200 au lieu de pas 200 », qui ne nomme pas le dégât.
      expect(await enBase(), `tour ${tour}`).toEqual({
        groupes: 2,
        matchs: 12,
        finaux: 0,
        statut: "running",
      });

      // Et l'un des deux appels doit être refusé — 409 (« déjà généré ») ou 500 si Postgres a
      // tranché le conflit. Jamais deux 200.
      expect(statuts[0], `tour ${tour}`).toBe(200);
      expect(statuts[1], `tour ${tour}`).not.toBe(200);
    }
  }, 120_000);

  it("le second clic, séquentiel, est refusé en 409", async () => {
    // Le cas ordinaire : la réponse s'est perdue, le créateur reclique. Rien ne doit bouger.
    tournoiId = await nouveauBrouillon("pools");
    const corps = { kind: "pools", poolSizes: [4, 4] };

    expect((await generate(req(createur, corps), params())).status).toBe(200);
    const apres = await enBase();

    const res = await generate(req(createur, corps), params());
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "Tournoi déjà généré" });
    expect(await enBase()).toEqual(apres);
  }, 30_000);

  it("DEUX phases finales simultanées ne créent qu'UN seul lot de tableaux — dix fois", async () => {
    // 2 poules de 4 → 4 tiers (1ers, 2es, 3es, 4es), 2 joueurs chacun → 1 match par tier.
    // Un doublon donnerait 8 matchs finaux : deux « finales des 1ers » avec les mêmes joueurs,
    // deux vainqueurs possibles, et un champion que la sérialisation tire au hasard.
    for (let tour = 1; tour <= 10; tour++) {
      tournoiId = await nouveauBrouillon("pools_bracket");
      await generate(req(createur, { kind: "pools_bracket", poolSizes: [4, 4] }), params());
      await joueLesPoules();

      const [ra, rb] = await Promise.all([
        finals(req(createur), params()),
        finals(req(createur), params()),
      ]);
      const statuts = [ra.status, rb.status].sort();

      const { finaux } = await enBase();
      expect(finaux, `tour ${tour}`).toBe(4);

      expect(statuts[0], `tour ${tour}`).toBe(200);
      expect(statuts[1], `tour ${tour}`).not.toBe(200);
    }
  }, 120_000);

  it("refuse la phase finale tant qu'un match de poule reste à jouer", async () => {
    tournoiId = await nouveauBrouillon("pools_bracket");
    await generate(req(createur, { kind: "pools_bracket", poolSizes: [4, 4] }), params());
    await joueLesPoules();
    // On rouvre un seul match : la phase finale figerait des classements provisoires.
    const un = await prisma.match.findFirst({ where: { tournamentId: tournoiId, phase: "pool" } });
    await prisma.match.update({
      where: { id: un?.id as string },
      data: { status: "pending", winnerId: null, score1: null, score2: null },
    });

    const res = await finals(req(createur), params());
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "Toutes les poules ne sont pas terminées",
    });
    expect((await enBase()).finaux).toBe(0);
  }, 30_000);
});

/** Chaque cas travaille sur son propre tournoi : on efface entre deux. */
function afterEachNettoie() {
  beforeEach(async () => {
    await prisma.tournament.deleteMany({ where: { name: MARQUEUR } });
    tournoiId = "";
  });
}

describe.skipIf(!SANS_BASE)("SUR VRAIE BASE — non mesuré", () => {
  it("la double génération n'est pas vérifiée sans base (TEST_DATABASE_URL)", () => {
    expect(SANS_BASE).toBe(true);
  });
});
