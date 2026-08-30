// CE QUE LA PURGE SUPPRIME VRAIMENT — sur une vraie base.
//
// `notify-store.ts` porte une décision de coût : plutôt qu'un cron, une purge OPPORTUNISTE,
// jouée à chaque écriture mais restreinte aux membres qu'on vient d'écrire. Le commentaire
// explique pourquoi (« la clause porte alors sur l'index (userId, createdAt), là où un balayage
// global aurait parcouru toute la table à CHAQUE notification »).
//
// Un faux client ne peut pas éprouver cette clause : il rend l'objet qu'on lui a passé. La
// question — quelles lignes disparaissent, et surtout lesquelles SURVIVENT — ne se pose qu'à
// Postgres. Et l'erreur qu'on cherche ici est silencieuse dans les deux sens : une purge trop
// large efface la cloche d'un membre qui n'était même pas concerné par l'envoi, une purge qui
// ne purge rien laisse la table grossir sans que personne ne le voie.
//
// Le préambule (garde-fou de base jetable, mode d'emploi du conteneur) vit dans `pg-harness.ts`.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { SANS_BASE, ouvrirBaseDeTest } from "./pg-harness";
import { NOTIFICATION_RETENTION_DAYS } from "./notifications-shared";

type Prisma = import("@prisma/client").PrismaClient;

let prisma: Prisma;
let recordNotifications: typeof import("./notify-store").recordNotifications;

const MARQUEUR = "PG-TEST-notify-store";
let vise = ""; // le membre destinataire de l'envoi
let temoin = ""; // un autre membre, que l'envoi ne concerne pas

const JOUR = 86_400_000;
const notif = { title: "Rencontre terminée", body: "Équipe 1 3 – 1 Massy" };

/** Pose une ligne de journal à une ancienneté choisie. */
async function ligne(userId: string, ageJours: number, titre: string) {
  await prisma.appNotification.create({
    data: {
      userId,
      title: titre,
      body: "corps",
      createdAt: new Date(Date.now() - ageJours * JOUR),
    },
  });
}

async function titres(userId: string) {
  const l = await prisma.appNotification.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { title: true },
  });
  return l.map((x) => x.title);
}

describe.skipIf(SANS_BASE)("SUR VRAIE BASE — la purge du journal", () => {
  beforeAll(async () => {
    prisma = await ouvrirBaseDeTest();
    ({ recordNotifications } = await import("./notify-store"));

    const a = await prisma.user.create({ data: { displayName: `${MARQUEUR} visé` } });
    vise = a.id;
    const b = await prisma.user.create({ data: { displayName: `${MARQUEUR} témoin` } });
    temoin = b.id;
  }, 60_000);

  afterAll(async () => {
    if (!vise) return;
    // Les notifications tombent avec leur membre (Cascade).
    await prisma.user.deleteMany({ where: { id: { in: [vise, temoin] } } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.appNotification.deleteMany({ where: { userId: { in: [vise, temoin] } } });
  });

  it("efface les lignes de plus de 30 jours du membre écrit, et garde les récentes", async () => {
    await ligne(vise, NOTIFICATION_RETENTION_DAYS + 1, "vieille");
    await ligne(vise, NOTIFICATION_RETENTION_DAYS - 1, "récente");

    await recordNotifications([vise], notif);

    expect(await titres(vise)).toEqual(["récente", notif.title]);
  });

  it("NE TOUCHE PAS au journal d'un membre que l'envoi ne concernait pas", async () => {
    // Le cœur de la décision : la purge est restreinte aux destinataires. Une clause qui
    // oublierait `userId` supprimerait ici la vieille ligne du témoin — et personne ne s'en
    // apercevrait, puisqu'une cloche vide ressemble à une cloche sans nouvelles.
    await ligne(temoin, NOTIFICATION_RETENTION_DAYS + 10, "vieille du témoin");
    await ligne(vise, NOTIFICATION_RETENTION_DAYS + 10, "vieille du visé");

    await recordNotifications([vise], notif);

    expect(await titres(temoin)).toEqual(["vieille du témoin"]);
    expect(await titres(vise)).toEqual([notif.title]);
  });

  it("écrit bien la notification demandée, url et tag compris", async () => {
    await recordNotifications([vise, temoin], {
      title: "Jeu terminé",
      body: "11 – 9",
      url: "/interclub/f1",
      tag: "interclub-f1",
    });

    const l = await prisma.appNotification.findMany({ where: { userId: { in: [vise, temoin] } } });
    expect(l).toHaveLength(2);
    expect(l[0]).toMatchObject({ title: "Jeu terminé", url: "/interclub/f1", tag: "interclub-f1" });
    // Non lue à la création : c'est ce qui alimente la pastille de la cloche.
    expect(l[0].readAt).toBeNull();
  });

  it("survit à un membre inexistant sans jeter, et sans écrire à moitié", async () => {
    // La liste des destinataires vient d'une requête sur `InterclubFollow` ; un compte supprimé
    // entre la lecture et l'écriture produit une violation de clé étrangère. Le journal ne doit
    // pas faire échouer l'envoi — ni, ici, laisser une écriture partielle derrière lui.
    await expect(
      recordNotifications([vise, "membre-qui-n-existe-pas"], notif),
    ).resolves.toBeUndefined();
    expect(await titres(vise)).toEqual([]);
  });
});

describe.skipIf(!SANS_BASE)("SUR VRAIE BASE — non mesuré", () => {
  it("la purge du journal n'est pas vérifiée tant qu'aucune base n'est fournie", () => {
    expect(SANS_BASE).toBe(true);
  });
});
