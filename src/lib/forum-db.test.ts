import { describe, it, expect, beforeEach, vi } from "vitest";

// LA COLLE ENTRE LA BASE ET L'ÉCRAN — le module qui décide QUI EST NOMMÉ.
//
// Il n'avait aucun test, et tous ses appelants le mocquent : le regroupement des réactions par
// emoji, la liste des votants d'une option, les replis « Membre supprimé », l'ordre des
// options, la composition d'une citation. Vider entièrement `shapePoll` ne faisait tomber aucun
// test node — le test de la diffusion d'un sondage assertait `id === "p1"` sur des valeurs qui
// venaient littéralement de son propre double de `relireSondage`.
//
// Ce que ces tests éprouvent est justement ce qui n'a pas d'autre gardien :
//  1. UNE CITATION EST COMPOSÉE À LA LECTURE, jamais lue dans la ligne. C'est la propriété qui
//     fait que la parole d'un membre disparaît vraiment quand il l'efface ou quand il part.
//  2. LES NOMS SONT EXPOSÉS. La notice qualifie le vote de « pas anonyme » : si `voters`
//     ressortait vide ou sans nom, la promesse serait fausse dans l'autre sens.
//  3. LES REPLIS. Un compte supprimé en cascade laisse une jointure nulle pendant l'effacement ;
//     rendre « null » à l'écran afficherait « null » à un membre.

const h = vi.hoisted(() => ({
  reactions: [] as Array<Record<string, unknown>>,
  polls: [] as Array<Record<string, unknown>>,
  /** Les arguments du dernier `findMany` : on vérifie qu'il n'y en a qu'UN pour toute la page. */
  reacArgs: null as null | Record<string, unknown>,
  reacAppels: 0,
  pollAppels: 0,
}));

vi.mock("./db", () => ({
  prisma: {
    forumReaction: {
      findMany: vi.fn(async (args: Record<string, unknown>) => {
        h.reacArgs = args;
        h.reacAppels += 1;
        return h.reactions;
      }),
    },
    forumPoll: {
      findMany: vi.fn(async () => {
        h.pollAppels += 1;
        return h.polls;
      }),
      findUnique: vi.fn(async () => h.polls[0] ?? null),
    },
  },
}));

import {
  shapeMessage,
  shapePoll,
  chargerReactions,
  chargerSondages,
  relireSondage,
  EXCERPT_LEN,
} from "./forum-db";

const ligne = (over: Record<string, unknown> = {}) =>
  ({
    id: "m1",
    body: "Salut",
    authorId: "u2",
    createdAt: new Date("2026-09-05T18:00:00Z"),
    replyToId: null,
    author: { displayName: "Gégé" },
    replyTo: null,
    ...over,
  }) as Parameters<typeof shapeMessage>[0];

beforeEach(() => {
  h.reactions = [];
  h.polls = [];
  h.reacArgs = null;
  h.reacAppels = 0;
  h.pollAppels = 0;
});

describe("shapeMessage — la citation est COMPOSÉE, jamais stockée", () => {
  it("tire le nom et l'extrait de la jointure sur la cible", () => {
    const out = shapeMessage(
      ligne({
        replyToId: "a",
        replyTo: { body: "Covoit jeudi : 4 places", author: { displayName: "Marie" } },
      }),
    );
    expect(out.replyToId).toBe("a");
    expect(out.replyToAuthor).toBe("Marie");
    expect(out.replyToExcerpt).toBe("Covoit jeudi : 4 places");
  });

  // LE DÉFAUT QUE CE TEST VERROUILLE : le nom et l'extrait étaient DÉNORMALISÉS dans la ligne
  // de la réponse. Ni la purge des 12 mois ni la cascade de suppression d'un compte ne les
  // atteignaient, et le GET les servait quand même — la notice promet le contraire.
  it("ne rend RIEN quand la cible a disparu : ni clé, ni nom, ni texte", () => {
    const out = shapeMessage(ligne({ replyToId: null, replyTo: null }));
    expect(out.replyToId).toBeNull();
    expect(out.replyToAuthor).toBeNull();
    expect(out.replyToExcerpt).toBeNull();
  });

  // Les trois champs vont ENSEMBLE. Une clé survivante sans sa cible afficherait une citation
  // vide : un filet à gauche, un nom absent, et rien dedans.
  it("neutralise la clé quand la jointure ne rend rien", () => {
    const out = shapeMessage(ligne({ replyToId: "a", replyTo: null }));
    expect(out.replyToId).toBeNull();
  });

  it("BORNE l'extrait cité : assez pour reconnaître, trop peu pour relire", () => {
    const out = shapeMessage(
      ligne({ replyToId: "a", replyTo: { body: "a".repeat(500), author: null } }),
    );
    expect([...(out.replyToExcerpt ?? "")].length).toBe(EXCERPT_LEN);
    expect(out.replyToExcerpt?.endsWith("…")).toBe(true);
  });

  it("nomme l'auteur disparu, et celui de la cible disparue, au lieu de rendre « null »", () => {
    const out = shapeMessage(
      ligne({ author: null, replyToId: "a", replyTo: { body: "Coucou", author: null } }),
    );
    expect(out.authorName).toBe("Membre supprimé");
    expect(out.replyToAuthor).toBe("Membre supprimé");
  });

  it("rend la date en ISO, la seule forme que le client sait comparer et trier", () => {
    expect(shapeMessage(ligne()).createdAt).toBe("2026-09-05T18:00:00.000Z");
  });
});

describe("chargerReactions — le regroupement par emoji", () => {
  it("regroupe par emoji et NOMME chaque réactant", async () => {
    h.reactions = [
      { messageId: "m1", emoji: "👍", userId: "u1", user: { displayName: "Thomas" } },
      { messageId: "m1", emoji: "👍", userId: "u2", user: { displayName: "Gégé" } },
      { messageId: "m1", emoji: "❤️", userId: "u2", user: { displayName: "Gégé" } },
      { messageId: "m2", emoji: "👍", userId: "u1", user: { displayName: "Thomas" } },
    ];
    const out = await chargerReactions(["m1", "m2"]);
    expect(out.m1.map((r) => r.emoji)).toEqual(["👍", "❤️"]);
    expect(out.m1[0].users.map((u) => u.name)).toEqual(["Thomas", "Gégé"]);
    expect(out.m1[1].users).toEqual([{ id: "u2", name: "Gégé" }]);
    // Le décompte affiché est `users.length` : c'est le regroupement qui le porte, pas un total.
    expect(out.m1[0].users).toHaveLength(2);
    expect(out.m2[0].users).toHaveLength(1);
  });

  it("nomme un réactant dont le compte a disparu", async () => {
    h.reactions = [{ messageId: "m1", emoji: "👍", userId: "u9", user: null }];
    const out = await chargerReactions(["m1"]);
    expect(out.m1[0].users[0].name).toBe("Membre supprimé");
  });

  // C'EST LE POINT QUI DÉCIDE DU COÛT : un `include` par message aurait produit trente requêtes
  // là où un `in` sur des identifiants déjà connus n'en fait qu'une.
  it("fait UNE requête pour toute la page, quel que soit le nombre de messages", async () => {
    await chargerReactions(["m1", "m2", "m3", "m4", "m5"]);
    expect(h.reacAppels).toBe(1);
    expect(h.reacArgs?.where).toEqual({ messageId: { in: ["m1", "m2", "m3", "m4", "m5"] } });
  });

  it("ne touche pas la base pour une page vide", async () => {
    expect(await chargerReactions([])).toEqual({});
    expect(h.reacAppels).toBe(0);
  });
});

describe("shapePoll — le vote n'est PAS secret", () => {
  const brut = {
    id: "p1",
    messageId: "m1",
    closedAt: null,
    options: [
      {
        id: "o1",
        label: "Jeudi",
        votes: [
          { userId: "u1", user: { displayName: "Thomas" } },
          { userId: "u2", user: { displayName: "Gégé" } },
        ],
      },
      { id: "o2", label: "Vendredi", votes: [] },
    ],
  };

  // La notice dit « chacun peut voir qui a coché quoi ». Si `voters` ressortait vide ou sans
  // nom, la promesse serait fausse — et l'infobulle de l'écran n'aurait rien à montrer.
  it("expose les NOMS des votants de chaque option", () => {
    const out = shapePoll(brut);
    expect(out.options[0].voters).toEqual([
      { id: "u1", name: "Thomas" },
      { id: "u2", name: "Gégé" },
    ]);
    expect(out.options[1].voters).toEqual([]);
  });

  it("garde l'ORDRE des options tel que la requête l'a trié", () => {
    expect(shapePoll(brut).options.map((o) => o.label)).toEqual(["Jeudi", "Vendredi"]);
  });

  it("nomme un votant dont le compte a disparu", () => {
    const out = shapePoll({
      ...brut,
      options: [{ id: "o1", label: "Jeudi", votes: [{ userId: "u9", user: null }] }],
    });
    expect(out.options[0].voters[0].name).toBe("Membre supprimé");
  });

  it("rend `closedAt` en ISO, ou null — c'est lui qui verrouille l'écran", () => {
    expect(shapePoll(brut).closedAt).toBeNull();
    expect(shapePoll({ ...brut, closedAt: new Date("2026-09-05T20:00:00Z") }).closedAt).toBe(
      "2026-09-05T20:00:00.000Z",
    );
  });

  // Le sondage EST un message : c'est `messageId` qui permet à l'écran de raccrocher un sondage
  // diffusé à sa place dans le fil. Le perdre rendrait la diffusion inexploitable.
  it("porte le `messageId` du message porteur", () => {
    expect(shapePoll(brut).messageId).toBe("m1");
  });
});

describe("chargerSondages et relireSondage", () => {
  it("indexe les sondages par `messageId`, et non par leur propre identifiant", async () => {
    h.polls = [{ id: "p1", messageId: "m1", closedAt: null, options: [] }];
    const out = await chargerSondages(["m1"]);
    expect(Object.keys(out)).toEqual(["m1"]);
    expect(out.m1.id).toBe("p1");
  });

  it("ne touche pas la base pour une page vide", async () => {
    expect(await chargerSondages([])).toEqual({});
    expect(h.pollAppels).toBe(0);
  });

  it("rend null quand le sondage relu a disparu entre-temps", async () => {
    h.polls = [];
    expect(await relireSondage("p1")).toBeNull();
  });

  it("met en forme le sondage relu comme celui d'une page — même module, même vérité", async () => {
    h.polls = [
      {
        id: "p1",
        messageId: "m1",
        closedAt: null,
        options: [
          { id: "o1", label: "Jeudi", votes: [{ userId: "u1", user: { displayName: "Thomas" } }] },
        ],
      },
    ];
    const out = await relireSondage("p1");
    expect(out?.options[0].voters).toEqual([{ id: "u1", name: "Thomas" }]);
  });
});
