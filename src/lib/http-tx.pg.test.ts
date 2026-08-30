// CE QU'UN FAUX CLIENT NE PEUT PAS DIRE — deux transactions concurrentes, sur un vrai Postgres.
//
// `http-tx.test.ts` décrit la mécanique de la boucle avec un faux client : quels codes elle
// rejoue, quelles options elle passe. Ce qu'il ne peut pas dire, par construction, c'est ce que
// Postgres RÉPOND — sur une question de concurrence, un mock rend le code qu'on lui a soufflé.
// D'où ce fichier. Trois questions y sont posées, toutes venues de `docs/interclub.md` :
//
//   A. le motif « supprimer puis réinsérer les jeux » sort-il en P2034 (rejoué) ou en P2002
//      (violation d'unicité, PAS rejouée, donc 500 pour le marqueur) ?
//   B. les défauts de Prisma (`timeout`, `maxWait`) sont-ils ceux qu'on croit, et que produisent-
//      ils quand on les dépasse ?
//   C. « la rencontre commence » ne part-elle vraiment qu'UNE fois quand deux marqueurs
//      entament leur simple en même temps ? C'est la promesse la plus chère de la branche —
//      elle se paie en notifications à tout le club.
//
// Le préambule (garde-fou de base jetable, variables d'environnement, mode d'emploi du
// conteneur) vit dans `pg-harness.ts` — il est partagé avec les autres tests sur vraie base.
//
// Sans `TEST_DATABASE_URL`, le fichier se SAUTE — `npm test` reste rapide et hors-ligne. Il ne
// se saute pas en silence : le test « non mesuré » en bas de fichier dit à voix haute qu'il n'a
// rien mesuré, pour qu'une suite verte ne se lise pas comme une suite qui a répondu.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SANS_BASE, URL_TEST, codePrisma, jalon, ouvrirBaseDeTest } from "./pg-harness";

// Types seulement : `@prisma/client` n'est importé qu'À L'EXÉCUTION, une fois `DATABASE_URL`
// posée par le harnais. Un import statique construirait le singleton AVANT, donc sur la
// mauvaise base — ou jetterait « Environment variable not found » sur un poste sans `.env`.
type Prisma = import("@prisma/client").PrismaClient;
type Tx = import("@prisma/client").Prisma.TransactionClient;
type TxFn = typeof import("./http-tx").serializableTransaction;

let prisma: Prisma;
let serializableTransaction: TxFn;
let derivedStatus: typeof import("./interclub-db").derivedStatus;
let Serializable: "Serializable";

const MARQUEUR = "PG-TEST-http-tx";
let userId = "";
let teamId = "";
let fixtureId = "";
let matchId = "";
let matchId2 = "";

/** Le corps de transaction du marqueur, réduit à ce qui touche `InterclubGame`. */
async function ecritureMarqueur(tx: Tx, jeux: { home: number; away: number }[]) {
  await tx.interclubGame.deleteMany({ where: { matchId } });
  await tx.interclubGame.createMany({
    data: jeux.map((g, i) => ({
      matchId,
      number: i + 1,
      pointsHome: g.home,
      pointsAway: g.away,
      finishedAt: new Date(),
    })),
  });
}

describe.skipIf(SANS_BASE)("SUR VRAIE BASE — deux transactions concurrentes", () => {
  beforeAll(async () => {
    prisma = await ouvrirBaseDeTest();
    const client = await import("@prisma/client");
    Serializable = client.Prisma.TransactionIsolationLevel.Serializable;
    ({ serializableTransaction } = await import("./http-tx"));
    // Le VRAI `derivedStatus`, pas une copie : le cas C reproduit la garde de la route, et une
    // reproduction qui recalculerait le statut à sa façon ne prouverait rien sur la route.
    ({ derivedStatus } = await import("./interclub-db"));

    const u = await prisma.user.create({ data: { displayName: `${MARQUEUR} joueur` } });
    userId = u.id;
    const t = await prisma.interclubTeam.create({
      data: { name: `${MARQUEUR} équipe`, order: 99 },
    });
    teamId = t.id;
    const f = await prisma.interclub.create({
      data: { date: "2026-09-03", teamId, opponent: MARQUEUR, createdById: userId, matchCount: 2 },
    });
    fixtureId = f.id;
    // DEUX simples, et c'est le décor du cas C : une soirée de rencontre, c'est deux marqueurs
    // sur deux courts, donc deux transactions qui touchent des simples DIFFÉRENTS mais la même
    // ligne `Interclub`. Les cas A et B n'utilisent que le premier.
    const m1 = await prisma.interclubMatch.create({
      data: { interclubId: fixtureId, order: 1, homeDisplayName: "Moi", awayName: "Lui" },
    });
    matchId = m1.id;
    const m2 = await prisma.interclubMatch.create({
      data: { interclubId: fixtureId, order: 2, homeDisplayName: "L'autre", awayName: "Son adversaire" },
    });
    matchId2 = m2.id;
  }, 60_000);

  afterAll(async () => {
    if (!fixtureId) return;
    // L'ordre suit les clés étrangères : les jeux tombent avec le simple (Cascade), le simple
    // avec la rencontre ; l'équipe et le membre sont en Restrict, donc à retirer en dernier.
    await prisma.interclub.deleteMany({ where: { id: fixtureId } });
    await prisma.interclubTeam.deleteMany({ where: { id: teamId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SOUPÇON A — « supprimer puis réinsérer » : P2034 ou P2002 ?
  //
  // On rejoue EXACTEMENT ce que fait `PUT …/live` : lire les jeux, les supprimer tous,
  // réinsérer la liste complète. Deux marqueurs entrent, tous deux lisent l'état d'avant,
  // puis écrivent l'un après l'autre. Le second écrit donc sur un état qu'il n'a pas vu, et
  // réinsère des `(matchId, number)` que le premier vient de créer.
  // ───────────────────────────────────────────────────────────────────────────

  it("A — deux marqueurs simultanés : quel code Postgres remonte-t-il ?", async () => {
    await prisma.interclubGame.deleteMany({ where: { matchId } });

    const luParA = jalon();
    const luParB = jalon();
    const aCommite = jalon();

    // A lit, attend que B ait lu (pour que B travaille bien sur l'état d'AVANT), écrit, commit.
    const a = prisma
      .$transaction(
        async (tx) => {
          await tx.interclubMatch.findUnique({ where: { id: matchId }, include: { games: true } });
          luParA.ouvrir();
          await luParB.atteint;
          await ecritureMarqueur(tx, [{ home: 11, away: 9 }]);
        },
        { isolationLevel: Serializable },
      )
      .then(
        () => aCommite.ouvrir(),
        (e) => {
          aCommite.ouvrir();
          throw e;
        },
      );

    // B lit en même temps, puis n'écrit qu'APRÈS le commit de A : c'est le cas que le
    // Serializable ne couvre pas tout seul, et celui que `knownGameCount` garde en production.
    const b = prisma.$transaction(
      async (tx) => {
        await tx.interclubMatch.findUnique({ where: { id: matchId }, include: { games: true } });
        luParB.ouvrir();
        await luParA.atteint;
        await aCommite.atteint;
        await ecritureMarqueur(tx, [{ home: 11, away: 7 }]);
      },
      { isolationLevel: Serializable },
    );

    const [ra, rb] = await Promise.allSettled([a, b]);

    // La réponse tient en une ligne, et c'est elle qu'on vient chercher :
    const verdict = [ra, rb].map((r) => (r.status === "fulfilled" ? "ok" : codePrisma(r.reason)));
    // eslint-disable-next-line no-console
    console.log(`[soupçon A] A=${verdict[0]} · B=${verdict[1]}`);

    expect(ra.status).toBe("fulfilled");
    // ⚠️ VALEUR MESURÉE, pas devinée — à recaler sur la ligne imprimée ci-dessus si la version
    // de Postgres change. Ce que ce test protège, c'est que la réponse reste ÉCRITE.
    expect(rb.status).toBe("rejected");
    expect(codePrisma((rb as PromiseRejectedResult).reason)).toBe("P2034");
  }, 30_000);

  it("A2 — même course, mais sur un match QUI A DÉJÀ DES JEUX", async () => {
    // Variante indispensable : en A, la table est vide et le second entrant ne peut se cogner
    // qu'à l'INSERT. Ici les jeux préexistent — c'est le cas ordinaire d'un jeudi soir, où deux
    // téléphones réécrivent une liste déjà remplie. Le second passe alors par un DELETE de
    // lignes que le premier a lui-même supprimées puis recréées, et c'est le chemin par lequel
    // Postgres pourrait sortir un code différent.
    await prisma.interclubGame.deleteMany({ where: { matchId } });
    await prisma.interclubGame.createMany({
      data: [
        { matchId, number: 1, pointsHome: 11, pointsAway: 3 },
        { matchId, number: 2, pointsHome: 11, pointsAway: 4 },
      ],
    });

    const luParA = jalon();
    const luParB = jalon();
    const aCommite = jalon();

    const a = prisma
      .$transaction(
        async (tx) => {
          await tx.interclubGame.findMany({ where: { matchId } });
          luParA.ouvrir();
          await luParB.atteint;
          await ecritureMarqueur(tx, [
            { home: 11, away: 3 },
            { home: 11, away: 4 },
            { home: 11, away: 9 },
          ]);
        },
        { isolationLevel: Serializable },
      )
      .then(
        () => aCommite.ouvrir(),
        (e) => {
          aCommite.ouvrir();
          throw e;
        },
      );

    const b = prisma.$transaction(
      async (tx) => {
        await tx.interclubGame.findMany({ where: { matchId } });
        luParB.ouvrir();
        await luParA.atteint;
        await aCommite.atteint;
        await ecritureMarqueur(tx, [
          { home: 11, away: 3 },
          { home: 11, away: 4 },
          { home: 9, away: 11 },
        ]);
      },
      { isolationLevel: Serializable },
    );

    const [ra, rb] = await Promise.allSettled([a, b]);
    // eslint-disable-next-line no-console
    console.log(
      `[soupçon A2] A=${ra.status === "fulfilled" ? "ok" : codePrisma(ra.reason)} · ` +
        `B=${rb.status === "fulfilled" ? "ok" : codePrisma(rb.reason)}`,
    );

    expect(ra.status).toBe("fulfilled");
    expect(rb.status).toBe("rejected");
    expect(codePrisma((rb as PromiseRejectedResult).reason)).toBe("P2034");
  }, 30_000);

  it("A' — et à travers `serializableTransaction`, les deux écritures aboutissent-elles ?", async () => {
    // La question qui compte pour le marqueur : voit-il un 500, ou sa saisie passe-t-elle ? Si
    // le code sorti en A est rejoué, la boucle absorbe le conflit et les deux transactions
    // finissent par écrire. Sinon, l'une des deux perd son point.
    await prisma.interclubGame.deleteMany({ where: { matchId } });

    const luParA = jalon();
    const luParB = jalon();
    const aCommite = jalon();

    const a = serializableTransaction(async (tx) => {
      await tx.interclubMatch.findUnique({ where: { id: matchId }, include: { games: true } });
      luParA.ouvrir();
      await luParB.atteint;
      await ecritureMarqueur(tx, [{ home: 11, away: 9 }]);
    }).then(
      () => aCommite.ouvrir(),
      (e) => {
        aCommite.ouvrir();
        throw e;
      },
    );

    let toursDeB = 0;
    const b = serializableTransaction(async (tx) => {
      toursDeB += 1;
      await tx.interclubMatch.findUnique({ where: { id: matchId }, include: { games: true } });
      luParB.ouvrir();
      // Le premier tour attend A ; les suivants (le rejeu) ne doivent pas se rebloquer.
      if (toursDeB === 1) {
        await luParA.atteint;
        await aCommite.atteint;
      }
      await ecritureMarqueur(tx, [
        { home: 11, away: 7 },
        { home: 11, away: 5 },
      ]);
    });

    const [ra, rb] = await Promise.allSettled([a, b]);
    // eslint-disable-next-line no-console
    console.log(
      `[soupçon A'] A=${ra.status === "fulfilled" ? "ok" : codePrisma(ra.reason)} · ` +
        `B=${rb.status === "fulfilled" ? "ok" : codePrisma(rb.reason)} en ${toursDeB} tour(s)`,
    );

    expect(ra.status).toBe("fulfilled");
    expect(rb.status).toBe("fulfilled");
    expect(toursDeB).toBeGreaterThan(1); // il a bien fallu rejouer
    // Le dernier écrivain gagne, et il gagne ENTIÈREMENT : deux jeux, pas un mélange des deux.
    const restants = await prisma.interclubGame.findMany({
      where: { matchId },
      orderBy: { number: "asc" },
    });
    expect(restants.map((g) => [g.pointsHome, g.pointsAway])).toEqual([
      [11, 7],
      [11, 5],
    ]);
  }, 30_000);

  // ───────────────────────────────────────────────────────────────────────────
  // SOUPÇON B — les bornes de temps.
  //
  // Le `PATCH` enchaîne jusqu'à HUIT allers-retours dans la transaction, et le cold start Neon
  // est décrit comme « visible à l'œil nu ». Deux plafonds existent chez Prisma, et aucun n'est
  // posé ici : `timeout` (durée de la transaction) et `maxWait` (attente d'une connexion AVANT
  // de commencer). Ces tests mesurent les défauts réels et ce qu'ils produisent.
  // ───────────────────────────────────────────────────────────────────────────

  it("B1 — au-delà du `timeout` par défaut, la transaction meurt en P2028, et n'est PAS rejouée", async () => {
    const t0 = Date.now();
    let tours = 0;
    const r = await serializableTransaction(async (tx) => {
      tours += 1;
      await tx.$queryRawUnsafe("SELECT pg_sleep(6)::text");
      return "jamais atteint";
    }).catch((e) => e);
    const ecoule = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[soupçon B1] ${codePrisma(r)} après ${ecoule} ms, ${tours} tentative(s)`);

    expect(codePrisma(r)).toBe("P2028"); // « Transaction API error … expired »
    expect(tours).toBe(1); // pas un conflit de sérialisation ⇒ pas de rejeu ⇒ 500 côté route

    // ⚠️ MESURE CONTRE-INTUITIVE, et c'est la plus utile du fichier : le plafond n'INTERROMPT
    // rien. La requête va au bout de ses 6 s, et c'est seulement au retour que Prisma refuse la
    // transaction. `timeout` n'est donc pas un garde-fou de charge — il ne fait pas gagner une
    // milliseconde à la base, il transforme un travail ABOUTI en 500 puis l'annule. Ce que ça
    // coûte quand on ne le pose pas est donc exactement ce que ça coûte quand on le pose trop
    // bas : le marqueur attend, puis perd son point.
    expect(ecoule).toBeGreaterThanOrEqual(6_000);
  }, 30_000);

  it("B2 — le même travail passe dès qu'on pose un `timeout` : la borne est le seul obstacle", async () => {
    // Pendant du précédent, et c'est lui qui rend la décision applicable : si relever `timeout`
    // suffit, alors ne rien poser est un choix par défaut, pas une fatalité.
    const v = await prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe("SELECT pg_sleep(6)::text");
        return "abouti";
      },
      { isolationLevel: Serializable, timeout: 20_000 },
    );
    expect(v).toBe("abouti");
  }, 40_000);

  it("B3 — `maxWait` : une transaction qui n'obtient pas de connexion meurt AVANT d'avoir commencé", async () => {
    // Le cas Neon : la première écriture d'une soirée attend l'ouverture d'une connexion. Le
    // défaut `maxWait` (2 s annoncées) court AVANT le premier ordre SQL — un plafond qu'aucune
    // requête rapide ne compense. On le reproduit en saturant le pool à une connexion.
    const { PrismaClient } = await import("@prisma/client");
    const sep = URL_TEST.includes("?") ? "&" : "?";
    const etroit = new PrismaClient({
      datasources: { db: { url: `${URL_TEST}${sep}connection_limit=1` } },
    });
    try {
      const occupee = jalon();
      const relacher = jalon();
      const longue = etroit.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe("SELECT 1");
          occupee.ouvrir();
          await relacher.atteint;
        },
        { isolationLevel: Serializable, timeout: 20_000 },
      );
      await occupee.atteint;

      const t0 = Date.now();
      const r = await etroit
        .$transaction(async (tx) => tx.$queryRawUnsafe("SELECT 1"), {
          isolationLevel: Serializable,
        })
        .then(() => "ok" as const)
        .catch((e) => e);
      const attendu = Date.now() - t0;
      relacher.ouvrir();
      await longue;

      // eslint-disable-next-line no-console
      console.log(`[soupçon B3] ${r === "ok" ? "ok" : codePrisma(r)} après ${attendu} ms`);
      expect(r).not.toBe("ok");
      expect(codePrisma(r)).toBe("P2028");
      expect(attendu).toBeLessThan(5_000); // le plafond tombe bien avant la fin de la longue
    } finally {
      await etroit.$disconnect();
    }
  }, 40_000);

  it("B4 — avec le `maxWait` retenu, la même attente aboutit au lieu de sortir en 500", async () => {
    // Contre-épreuve de B3, et la seule qui justifie la valeur posée dans `http-tx.ts` : même
    // pool saturé, même attente, mais on tient la connexion 3 s — au-delà des 2 s du défaut. Si
    // les dix secondes servent à quelque chose, la seconde transaction ne meurt plus, elle
    // attend son tour. C'est exactement ce qu'on achète pour la première écriture d'une soirée.
    const { PrismaClient } = await import("@prisma/client");
    const sep = URL_TEST.includes("?") ? "&" : "?";
    const etroit = new PrismaClient({
      datasources: { db: { url: `${URL_TEST}${sep}connection_limit=1` } },
    });
    try {
      const occupee = jalon();
      const relacher = jalon();
      const longue = etroit.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe("SELECT 1");
          occupee.ouvrir();
          await relacher.atteint;
        },
        { isolationLevel: Serializable, timeout: 20_000 },
      );
      await occupee.atteint;
      setTimeout(() => relacher.ouvrir(), 3_000);

      const t0 = Date.now();
      const r = await etroit
        .$transaction(async (tx) => tx.$queryRawUnsafe("SELECT 1"), {
          isolationLevel: Serializable,
          maxWait: 10_000, // la valeur de `MAX_WAIT_MS` — c'est elle qu'on éprouve
        })
        .then(() => "ok" as const)
        .catch((e) => e);
      const attendu = Date.now() - t0;
      await longue;

      // eslint-disable-next-line no-console
      console.log(`[soupçon B4] ${r === "ok" ? "ok" : codePrisma(r)} après ${attendu} ms`);
      expect(r).toBe("ok");
      expect(attendu).toBeGreaterThan(2_000); // elle a bien dépassé le défaut, sans en mourir
    } finally {
      await etroit.$disconnect();
    }
  }, 40_000);

  // ───────────────────────────────────────────────────────────────────────────
  // CAS C — « LA RENCONTRE COMMENCE » NE PART QU'UNE FOIS.
  //
  // C'est la promesse la plus coûteuse de la branche quand elle casse : une notification à TOUS
  // les abonnés de l'équipe. `docs/interclub.md` la fait reposer sur un marqueur persistant
  // (`Interclub.startNotifiedAt`), lu en début de transaction et posé à la fin — « un marqueur
  // ne se réarme pas ».
  //
  // Mais un marqueur lu puis écrit dans deux transactions CONCURRENTES ne garantit rien par
  // lui-même : si les deux lisent `null` avant que l'une écrive, les deux annoncent. Or c'est
  // exactement la situation d'un jeudi soir — deux marqueurs, deux courts, le premier point
  // marqué à quelques secondes d'intervalle, et la MÊME ligne `Interclub` mise à jour par les
  // deux transactions. Aucun test à faux client ne peut répondre : la question est de savoir ce
  // que Postgres laisse passer.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * La garde de la route `PUT …/live`, reproduite : lire le simple et sa rencontre, écrire le
   * premier point, dériver le statut de la rencontre, puis ne poser `startNotifiedAt` que s'il
   * était nul. Rend `true` si CETTE transaction croit devoir annoncer le début.
   */
  function premierPoint(tx: Tx, mid: string) {
    return (async () => {
      const m = await tx.interclubMatch.findUnique({
        where: { id: mid },
        include: { interclub: { select: { id: true, matchCount: true, startNotifiedAt: true } } },
      });
      if (!m) throw new Error("simple introuvable");

      await tx.interclubMatch.update({
        where: { id: mid },
        data: { status: "live", gamesHome: 0, gamesAway: 0 },
      });

      const siblings = await tx.interclubMatch.findMany({
        where: { interclubId: m.interclubId },
        select: { gamesHome: true, status: true },
      });
      const nextStatus = derivedStatus(m.interclub.matchCount, siblings);
      const fixtureStarted = nextStatus === "live" && m.interclub.startNotifiedAt === null;

      await tx.interclub.update({
        where: { id: m.interclubId },
        data: {
          status: nextStatus,
          ...(fixtureStarted ? { startNotifiedAt: new Date() } : {}),
        },
      });
      return fixtureStarted;
    })();
  }

  /** Remet la rencontre à l'état d'avant la soirée. */
  async function remiseAZero() {
    await prisma.interclub.update({
      where: { id: fixtureId },
      data: { status: "scheduled", startNotifiedAt: null, doneNotifiedAt: null },
    });
    await prisma.interclubMatch.updateMany({
      where: { interclubId: fixtureId },
      data: { status: "pending", gamesHome: null, gamesAway: null },
    });
  }

  it("C — deux marqueurs entament leur match en même temps : UNE seule annonce", async () => {
    await remiseAZero();

    const luParA = jalon();
    const luParB = jalon();

    // Les deux lisent AVANT que l'une ou l'autre n'écrive : c'est le seul entrelacement qui
    // peut produire la double annonce, donc le seul qui vaille d'être mesuré.
    const a = serializableTransaction(async (tx) => {
      const m = await tx.interclub.findUnique({ where: { id: fixtureId } });
      luParA.ouvrir();
      await luParB.atteint;
      void m;
      return premierPoint(tx, matchId);
    });
    const b = serializableTransaction(async (tx) => {
      const m = await tx.interclub.findUnique({ where: { id: fixtureId } });
      luParB.ouvrir();
      await luParA.atteint;
      void m;
      return premierPoint(tx, matchId2);
    });

    const [ra, rb] = await Promise.allSettled([a, b]);
    // eslint-disable-next-line no-console
    console.log(
      `[cas C] A=${ra.status === "fulfilled" ? `annonce=${ra.value}` : codePrisma(ra.reason)} · ` +
        `B=${rb.status === "fulfilled" ? `annonce=${rb.value}` : codePrisma(rb.reason)}`,
    );

    // Les deux écritures doivent ABOUTIR — perdre le premier point d'un simple serait un autre
    // défaut, et la boucle de réessai est là pour ça.
    expect(ra.status).toBe("fulfilled");
    expect(rb.status).toBe("fulfilled");

    const annonces = [ra, rb].filter(
      (r) => r.status === "fulfilled" && r.value === true,
    ).length;
    expect(annonces).toBe(1); // ni zéro (personne prévenu), ni deux (tout le club, deux fois)

    // Et le marqueur est bien posé une fois pour toutes.
    const f = await prisma.interclub.findUnique({ where: { id: fixtureId } });
    expect(f!.startNotifiedAt).not.toBeNull();
    expect(f!.status).toBe("live");
  }, 30_000);

  it("C2 — contre-épreuve : en Read Committed, la même course annonce DEUX fois", async () => {
    // Ce que le test C mesure vraiment, c'est le niveau d'ISOLATION — pas le marqueur, qui ne
    // fait que constater. Sans cette contre-épreuve, C passerait tout aussi bien sur un code
    // qui n'aurait aucune protection, et on croirait le marqueur suffisant. Il ne l'est pas :
    // c'est `serializableTransaction` qui rend la garde atomique.
    await remiseAZero();

    const luParA = jalon();
    const luParB = jalon();

    const lache = (mid: string, moi: ReturnType<typeof jalon>, autre: ReturnType<typeof jalon>) =>
      prisma.$transaction(
        async (tx) => {
          const m = await tx.interclub.findUnique({ where: { id: fixtureId } });
          moi.ouvrir();
          await autre.atteint;
          void m;
          return premierPoint(tx, mid);
        },
        { isolationLevel: "ReadCommitted" },
      );

    const [ra, rb] = await Promise.allSettled([
      lache(matchId, luParA, luParB),
      lache(matchId2, luParB, luParA),
    ]);
    const annonces = [ra, rb].filter((r) => r.status === "fulfilled" && r.value === true).length;
    // eslint-disable-next-line no-console
    console.log(`[cas C2] ${annonces} annonce(s) en Read Committed`);

    expect(annonces).toBe(2); // la double annonce, obtenue exprès
  }, 30_000);
});

// Sans base, la suite doit DIRE qu'elle n'a pas répondu. Un fichier entièrement sauté se lit
// comme un fichier vert, et c'est précisément ce que ces deux soupçons ne doivent plus être.
describe.skipIf(!SANS_BASE)("SUR VRAIE BASE — non mesuré", () => {
  it("rien n'est vérifié sur la concurrence tant qu'aucune base n'est fournie (TEST_DATABASE_URL)", () => {
    expect(URL_TEST).toBe("");
  });
});
