// CE QUE LA BASE TIENT TOUTE SEULE POUR LE FIL — sur une vraie base.
//
// Quatre invariants du fil sont portés par le SCHÉMA et non par le code, et un faux client ne
// peut donc pas les éprouver : il rend ce qu'on lui a demandé de rendre.
//
//  1. L'INDEX UNIQUE (message, membre, emoji) rend la bascule d'une réaction idempotente.
//     Le retirer du schéma ne faisait tomber AUCUN test — les doubles ne connaissent pas les
//     contraintes. C'est pourtant lui qui empêche deux clics croisés de laisser deux lignes.
//
//  2. `ON DELETE SET NULL` sur `replyToId`. Supprimer un message effacé la citation qui le
//     reprenait, SANS emporter la réponse : effacer une question ne doit pas effacer la
//     discussion qu'elle a ouverte. C'est aussi ce qui remplace la dénormalisation d'un
//     instantané — le texte cité ne vit nulle part ailleurs que dans la ligne de son auteur,
//     donc il disparaît vraiment, par tous les chemins et pas seulement par la route DELETE.
//
//  3. LA CASCADE À LA SUPPRESSION D'UN COMPTE. La notice promet que « tout ce que tu y as
//     écrit disparaît avec ton compte » : messages, réactions et votes doivent partir avec lui.
//
//  4. L'UNICITÉ D'UN VOTE porte sur (option, membre) et NON sur (sondage, membre) — le vote est
//     à choix MULTIPLE, cocher deux cases fait bien deux lignes.
//
// Le préambule (garde-fou de base jetable, mode d'emploi du conteneur) vit dans `pg-harness.ts`.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { SANS_BASE, ouvrirBaseDeTest } from "./pg-harness";

type Prisma = import("@prisma/client").PrismaClient;

let prisma: Prisma;

const MARQUEUR = "PG-TEST-forum";
let auteur = "";
let autre = "";

describe.skipIf(SANS_BASE)("SUR VRAIE BASE — les invariants du fil", () => {
  beforeAll(async () => {
    prisma = await ouvrirBaseDeTest();
    const a = await prisma.user.create({ data: { displayName: `${MARQUEUR} auteur` } });
    auteur = a.id;
    const b = await prisma.user.create({ data: { displayName: `${MARQUEUR} autre` } });
    autre = b.id;
  }, 60_000);

  afterAll(async () => {
    if (!auteur) return;
    await prisma.user.deleteMany({ where: { id: { in: [auteur, autre] } } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.forumMessage.deleteMany({ where: { authorId: { in: [auteur, autre] } } });
  });

  const ecrire = (authorId: string, body: string, replyToId?: string) =>
    prisma.forumMessage.create({ data: { authorId, body, replyToId: replyToId ?? null } });

  describe("la bascule d'une réaction", () => {
    it("REFUSE une seconde réaction identique — c'est l'index unique qui le tient", async () => {
      const m = await ecrire(auteur, "Qui vient jeudi ?");
      await prisma.forumReaction.create({
        data: { messageId: m.id, userId: autre, emoji: "👍" },
      });
      // Le cas réel : deux clics à 200 ms d'intervalle, ou deux appareils. La route rattrape
      // ce jet et répond 200 ; ce qu'on éprouve ici, c'est que la base jette bien.
      await expect(
        prisma.forumReaction.create({ data: { messageId: m.id, userId: autre, emoji: "👍" } }),
      ).rejects.toMatchObject({ code: "P2002" });
    });

    it("laisse deux membres poser le MÊME emoji, et un membre poser DEUX emoji", async () => {
      const m = await ecrire(auteur, "Bien joué");
      await prisma.forumReaction.createMany({
        data: [
          { messageId: m.id, userId: auteur, emoji: "👍" },
          { messageId: m.id, userId: autre, emoji: "👍" },
          { messageId: m.id, userId: autre, emoji: "❤️" },
        ],
      });
      expect(await prisma.forumReaction.count({ where: { messageId: m.id } })).toBe(3);
    });

    it("emporte les réactions avec le message", async () => {
      const m = await ecrire(auteur, "Éphémère");
      await prisma.forumReaction.create({ data: { messageId: m.id, userId: autre, emoji: "👍" } });
      await prisma.forumMessage.delete({ where: { id: m.id } });
      expect(await prisma.forumReaction.count({ where: { messageId: m.id } })).toBe(0);
    });
  });

  describe("la citation", () => {
    // LE CŒUR DE LA CONCEPTION. Aucun texte cité n'est recopié dans la réponse : supprimer la
    // cible fait donc disparaître la citation ENTIÈRE, sans qu'aucune route n'ait à blanchir
    // quoi que ce soit. La purge des 12 mois et la cascade de suppression d'un compte en
    // bénéficient gratuitement — ce sont justement les deux chemins que le blanchiment par la
    // route ne couvrait pas.
    it("efface la citation quand la cible disparaît, SANS emporter la réponse", async () => {
      const cible = await ecrire(auteur, "Covoit jeudi : 4 places");
      const reponse = await ecrire(autre, "Je prends une place", cible.id);

      await prisma.forumMessage.delete({ where: { id: cible.id } });

      const relue = await prisma.forumMessage.findUnique({
        where: { id: reponse.id },
        include: { replyTo: true },
      });
      expect(relue).not.toBeNull();
      expect(relue?.body).toBe("Je prends une place");
      expect(relue?.replyToId).toBeNull();
      expect(relue?.replyTo).toBeNull();
    });

    // La preuve par la colonne : plus aucune ne peut porter un extrait. Si quelqu'un rétablit
    // une dénormalisation, ce test tombe — et c'est le seul endroit qui puisse le dire.
    it("ne garde AUCUNE colonne de texte cité sur le message", async () => {
      const cols = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'ForumMessage'`,
      );
      const noms = cols.map((c) => c.column_name);
      expect(noms).toContain("replyToId");
      expect(noms).not.toContain("replyToAuthor");
      expect(noms).not.toContain("replyToExcerpt");
    });
  });

  describe("le vote à choix multiple", () => {
    it("accepte DEUX lignes pour un membre sur deux options, et refuse le doublon", async () => {
      const m = await ecrire(auteur, "Quel soir ?");
      const poll = await prisma.forumPoll.create({
        data: {
          messageId: m.id,
          options: {
            create: [
              { label: "Jeudi", position: 0 },
              { label: "Vendredi", position: 1 },
            ],
          },
        },
        include: { options: { orderBy: { position: "asc" } } },
      });
      const [jeudi, vendredi] = poll.options;

      await prisma.forumPollVote.createMany({
        data: [
          { optionId: jeudi.id, userId: autre },
          { optionId: vendredi.id, userId: autre },
        ],
      });
      // L'unicité porte sur (option, membre) : deux cases cochées = deux lignes, c'est voulu.
      expect(
        await prisma.forumPollVote.count({ where: { optionId: { in: [jeudi.id, vendredi.id] } } }),
      ).toBe(2);

      await expect(
        prisma.forumPollVote.create({ data: { optionId: jeudi.id, userId: autre } }),
      ).rejects.toMatchObject({ code: "P2002" });
    });

    it("emporte le sondage, ses options et ses voix avec le message porteur", async () => {
      const m = await ecrire(auteur, "Resto après ?");
      const poll = await prisma.forumPoll.create({
        data: { messageId: m.id, options: { create: [{ label: "Chez Marco", position: 0 }] } },
        include: { options: true },
      });
      await prisma.forumPollVote.create({
        data: { optionId: poll.options[0].id, userId: autre },
      });

      await prisma.forumMessage.delete({ where: { id: m.id } });

      expect(await prisma.forumPoll.count({ where: { id: poll.id } })).toBe(0);
      expect(await prisma.forumPollOption.count({ where: { pollId: poll.id } })).toBe(0);
      expect(await prisma.forumPollVote.count({ where: { optionId: poll.options[0].id } })).toBe(0);
    });
  });

  // CE QUE LA NOTICE PROMET : « tout ce que tu y as écrit disparaît avec ton compte ». Ce test
  // est le seul qui puisse le vérifier — c'est la BASE qui l'exécute, par ses cascades, et
  // aucune route n'est traversée.
  describe("la suppression d'un compte", () => {
    it("emporte messages, réactions et votes du partant, et rien de ce qu'ont écrit les autres", async () => {
      const partant = await prisma.user.create({
        data: { displayName: `${MARQUEUR} partant` },
      });
      const sien = await ecrire(partant.id, "Ce que j'ai écrit");
      const dautrui = await ecrire(auteur, "Ce qu'a écrit quelqu'un d'autre");
      await prisma.forumReaction.create({
        data: { messageId: dautrui.id, userId: partant.id, emoji: "👍" },
      });
      const poll = await prisma.forumPoll.create({
        data: { messageId: dautrui.id, options: { create: [{ label: "Oui", position: 0 }] } },
        include: { options: true },
      });
      await prisma.forumPollVote.create({
        data: { optionId: poll.options[0].id, userId: partant.id },
      });

      await prisma.user.delete({ where: { id: partant.id } });

      expect(await prisma.forumMessage.count({ where: { id: sien.id } })).toBe(0);
      expect(await prisma.forumReaction.count({ where: { userId: partant.id } })).toBe(0);
      expect(await prisma.forumPollVote.count({ where: { userId: partant.id } })).toBe(0);
      // Le message des autres reste : partir n'efface pas la conversation du club.
      expect(await prisma.forumMessage.count({ where: { id: dautrui.id } })).toBe(1);
    });

    // Le cas que la dénormalisation rendait faux : une réponse d'un tiers CITAIT le message du
    // partant. Avant, l'extrait survivait dans la ligne du tiers, hors d'atteinte de la
    // cascade. Maintenant la clé passe à NULL et il ne reste rien à lire.
    it("ne laisse rien du texte d'un partant dans la citation d'un tiers", async () => {
      const partant = await prisma.user.create({ data: { displayName: `${MARQUEUR} cité` } });
      const cite = await ecrire(partant.id, "Mon numéro : 06 00 00 00 00");
      const reponse = await ecrire(auteur, "Noté", cite.id);

      await prisma.user.delete({ where: { id: partant.id } });

      const relue = await prisma.forumMessage.findUnique({
        where: { id: reponse.id },
        include: { replyTo: true },
      });
      expect(relue?.replyToId).toBeNull();
      expect(relue?.replyTo).toBeNull();
      expect(JSON.stringify(relue)).not.toContain("06 00 00 00 00");
    });
  });
});
