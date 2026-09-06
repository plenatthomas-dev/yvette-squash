import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// LE FIL DU CLUB — la route qui écrit et celle qui lit.
//
// Quatre choses ne se relisent pas dans le code et sont donc verrouillées ici :
//  1. LE PUSH NE PART PAS À L'AUTEUR, ni à ceux qui l'ont coupé. Se notifier soi-même est le
//     défaut classique de toute messagerie, et il ne se voit qu'à l'usage.
//  2. AUCUNE LIGNE NE PORTE `canDelete` NI `mine`. Ces droits dépendent de QUI REGARDE. Les
//     calculer par ligne obligeait à en figer un dans la diffusion, et un ADMIN voyait alors
//     tout le fil comme étant le sien. Le serveur envoie `meId`/`admin` une fois, le client
//     dérive — ces tests sont ce qui empêche la régression de revenir.
//  3. LE MESSAGE EST ÉCRIT AVANT D'ÊTRE DIFFUSÉ. L'ordre inverse ferait exister chez les
//     autres un message qui pourrait n'être jamais enregistré.
//  4. UNE CITATION N'EST QU'UNE CLÉ. Le client n'envoie qu'un identifiant — sinon n'importe
//     qui ferait dire n'importe quoi à n'importe qui, sous son nom — et rien du texte cité
//     n'est RECOPIÉ dans la ligne : il est relu par jointure à chaque lecture. C'est ce qui
//     fait que la parole d'un membre disparaît vraiment quand il l'efface ou quand il part.
//  5. UN RATTRAPAGE PORTE PLUS QUE LES MESSAGES NEUFS. Réagir, voter et supprimer ne créent
//     aucun message : sans la fenêtre visible dans la réponse, aucun des trois n'était jamais
//     rattrapé quand le courtier manquait — le cas même pour lequel le rattrapage existe.
//  6. LE JOURNAL DE LA CLOCHE NE PORTE PAS LE MESSAGE. Le push est transitoire, la ligne
//     `AppNotification` est une copie durable chez chaque destinataire.

const h = vi.hoisted(() => ({
  forumOn: true,
  session: { userId: "u1", displayName: "Thomas", email: "membre@example.com" } as {
    userId: string;
    displayName: string;
    email: string | null;
  } | null,
  recentCount: 0,
  /** Le `where` du dernier `count` : c'est lui qui borne la limite à UN membre. */
  countWhere: null as null | Record<string, unknown>,
  /** Les lignes rendues par `findMany` sur le fil, du plus récent au plus ancien. */
  rows: [] as Array<Record<string, unknown>>,
  /** Les membres que la route considère comme destinataires. */
  destinataires: [] as Array<{ id: string }>,
  /** Le `where` du dernier `user.findMany` — c'est lui qui exclut l'auteur et les silencieux. */
  destWhere: null as null | Record<string, unknown>,
  /** Le `where` du dernier `deleteMany` : la purge des 12 mois. */
  purge: null as null | Record<string, unknown>,
  /** Arguments de `pushToUsers` : [ids, payload]. */
  pushed: null as null | [string[], Record<string, unknown>],
  /** Arguments de `broadcastForum` : [event, payload]. */
  diffuse: null as null | [string, Record<string, unknown>],
  /** L'ordre réel des effets, pour prouver « écrit puis diffusé ». */
  ordre: [] as string[],
  since: null as null | { id: string; createdAt: Date },
  /** Le réglage « notifications coupées » du membre qui lit. */
  muted: false,
  /** Ce que le PATCH a écrit, ou null s'il n'a pas eu lieu. */
  regle: null as null | Record<string, unknown>,
  lastFindMany: null as null | Record<string, unknown>,
  /** TOUS les `findMany` du fil, dans l'ordre : le rattrapage en fait deux. */
  findManys: [] as Array<Record<string, unknown>>,
  /** Ce que la requête de fenêtre rend, quand un test veut la dissocier de `rows`. */
  fenetre: null as null | Array<{ id: string; createdAt: Date }>,
  /** Les identifiants sur lesquels la route a demandé réactions et sondages. */
  reacIds: null as null | string[],
  pollIds: null as null | string[],
  /** La cible d'une citation, telle que la base la rendrait — ou `null` si elle a disparu. */
  cible: null as null | Record<string, unknown>,
  /** Les données passées à `forumMessage.create` : on y vérifie qu'AUCUN texte cité n'est écrit. */
  cree: null as null | Record<string, unknown>,
  /** Le troisième argument de `pushToUsers` : ce que la cloche garde, distinct de ce qu'on pousse. */
  pushOpts: null as null | Record<string, unknown>,
}));

// `normalizeEmail` est réexporté ici pour `admin.ts`, qui s'en sert à lire l'allowlist : le
// mocker en no-op ferait passer le test de casse pour de mauvaises raisons.
vi.mock("@/lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session")>()),
  getSession: vi.fn(async () => h.session),
}));
vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({ forum: h.forumOn }),
}));
vi.mock("@/lib/push", () => ({
  pushToUsers: vi.fn(
    async (ids: string[], payload: Record<string, unknown>, opts?: Record<string, unknown>) => {
      h.pushed = [ids, payload];
      h.pushOpts = opts ?? null;
      return { recipients: ids.length, sent: ids.length };
    },
  ),
}));
vi.mock("@/lib/forum-realtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/forum-realtime")>()),
  broadcastForum: vi.fn(async (event: string, payload: Record<string, unknown>) => {
    h.ordre.push("diffuse");
    h.diffuse = [event, payload];
  }),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    forumMessage: {
      // Le `where` est CAPTURÉ, et non ignoré : sans lui, remplacer le prédicat de la route par
      // `{}` transformerait la limite de débit en plafond global au club — trente messages pour
      // tout le monde — sans faire rougir un seul test.
      count: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
        h.countWhere = args?.where ?? null;
        return h.recentCount;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        h.ordre.push("ecrit");
        h.cree = data;
        return {
          id: "m-neuf",
          body: data.body,
          authorId: data.authorId,
          createdAt: new Date("2026-09-05T18:42:00Z"),
          replyToId: data.replyToId ?? null,
          author: { displayName: "Thomas" },
          replyTo: null,
        };
      }),
      // DEUX requêtes distinctes en rattrapage : les messages (`select` complet, avec `body`)
      // et la FENÊTRE visible (`select: { id, createdAt }` seulement). Les confondre ferait
      // passer le test de la fenêtre pour de mauvaises raisons.
      findMany: vi.fn(async (args: Record<string, unknown>) => {
        h.findManys.push(args);
        const select = args.select as Record<string, unknown> | undefined;
        if (select && !select.body) {
          return h.fenetre ?? h.rows.map((r) => ({ id: r.id, createdAt: r.createdAt }));
        }
        h.lastFindMany = args;
        return h.rows;
      }),
      // Deux appelants : l'ancre du rattrapage (`select: { createdAt }`) et la cible d'une
      // citation (`select: { id }`). On les distingue sur le `select`, sinon le test du
      // rattrapage se ferait servir une cible de citation.
      findUnique: vi.fn(async (args: { select?: Record<string, unknown> }) =>
        args?.select?.createdAt ? h.since : h.cible,
      ),
      deleteMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        h.purge = args.where;
        return { count: 0 };
      }),
    },
    // Les réactions et les sondages d'une page : vides par défaut, la plupart des tests ne
    // portent pas dessus. Ce sont DEUX requêtes, pas une par message — voir forum-db.ts.
    forumReaction: {
      findMany: vi.fn(async (args: { where: { messageId: { in: string[] } } }) => {
        h.reacIds = args.where.messageId.in;
        return [];
      }),
    },
    forumPoll: {
      findMany: vi.fn(async (args: { where: { messageId: { in: string[] } } }) => {
        h.pollIds = args.where.messageId.in;
        return [];
      }),
    },
    user: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        h.destWhere = args.where;
        return h.destinataires;
      }),
      findUnique: vi.fn(async () => ({ forumMuted: h.muted, displayName: "Thomas" })),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        h.regle = args.data;
        return {};
      }),
    },
  },
}));

import { GET, POST, PATCH } from "./route";
import { MAX_FORUM_LEN } from "@/lib/forum";

const post = (body: unknown = "Coucou 👍", extra: Record<string, unknown> = {}) =>
  ({
    cookies: { get: () => ({ value: "sid" }) },
    json: async () => ({ body, ...extra }),
  }) as unknown as NextRequest;

const get = (qs = "") =>
  ({
    cookies: { get: () => ({ value: "sid" }) },
    nextUrl: { searchParams: new URLSearchParams(qs) },
  }) as unknown as NextRequest;

const ligne = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  body: "Salut",
  authorId: "u2",
  createdAt: new Date("2026-09-05T18:00:00Z"),
  replyToId: null,
  author: { displayName: "Gégé" },
  // La cible citée, telle que la JOINTURE la rend. Rien n'est stocké dans la ligne elle-même :
  // c'est tout l'objet de la conception, et ce que ce champ représente ici.
  replyTo: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_EMAILS = "chef@example.com";
  h.forumOn = true;
  h.session = { userId: "u1", displayName: "Thomas", email: "membre@example.com" };
  h.recentCount = 0;
  h.rows = [];
  h.destinataires = [{ id: "u2" }, { id: "u3" }];
  h.destWhere = null;
  h.purge = null;
  h.pushed = null;
  h.diffuse = null;
  h.ordre = [];
  h.since = null;
  h.lastFindMany = null;
  h.findManys = [];
  h.fenetre = null;
  h.reacIds = null;
  h.pollIds = null;
  h.countWhere = null;
  h.pushOpts = null;
  h.muted = false;
  h.regle = null;
  h.cible = null;
  h.cree = null;
});

describe("gardes — l'ordre est le même que partout dans l'appli", () => {
  it("404 quand la fonction est coupée, AVANT de regarder la session", async () => {
    h.forumOn = false;
    h.session = null;
    expect((await POST(post())).status).toBe(404);
    expect((await GET(get())).status).toBe(404);
  });

  it("401 quand personne n'est connecté", async () => {
    h.session = null;
    expect((await POST(post())).status).toBe(401);
    expect((await GET(get())).status).toBe(401);
  });
});

describe("POST — validation", () => {
  it("refuse un message vide ou fait d'espaces", async () => {
    expect((await POST(post(""))).status).toBe(400);
    expect((await POST(post("   \n  "))).status).toBe(400);
  });

  it("refuse un corps qui n'est pas une chaîne, au lieu de l'écrire en « null »", async () => {
    expect((await POST(post(42))).status).toBe(400);
    expect((await POST(post(null))).status).toBe(400);
  });

  it("écrit le message NETTOYÉ, pas le texte brut", async () => {
    const res = await POST(post("  Coucou   tout\t\tle monde  "));
    expect(res.status).toBe(201);
    expect((await res.json()).message.body).toBe("Coucou tout le monde");
  });

  it("garde les emoji entiers jusqu'en base", async () => {
    const res = await POST(post("Bien joué 👨‍👩‍👧‍👦 🇫🇷"));
    expect((await res.json()).message.body).toBe("Bien joué 👨‍👩‍👧‍👦 🇫🇷");
  });

  // LE DÉFAUT QUE CE TEST VERROUILLE : la route répondait 201 et la base gardait un message
  // COUPÉ NET à 1000. L'auteur d'un compte rendu de 1300 caractères croyait avoir tout envoyé.
  // Le message d'erreur de la route décrivait pourtant déjà les deux bornes.
  it("REFUSE en 400 un message trop long, au lieu de le tronquer et de rendre 201", async () => {
    const res = await POST(post("a".repeat(MAX_FORUM_LEN + 1)));
    expect(res.status).toBe(400);
    expect(h.cree).toBeNull();
    expect(h.diffuse).toBeNull();
    expect(h.pushed).toBeNull();
  });

  it("accepte un message posé exactement sur la limite", async () => {
    const res = await POST(post("a".repeat(MAX_FORUM_LEN)));
    expect(res.status).toBe(201);
    expect((h.cree?.body as string).length).toBe(MAX_FORUM_LEN);
  });
});

describe("POST — garde-fou anti-emballement", () => {
  it("laisse passer une conversation normale", async () => {
    h.recentCount = 29;
    expect((await POST(post())).status).toBe(201);
  });

  it("refuse en 429 au-delà de la limite, sans rien diffuser ni notifier", async () => {
    h.recentCount = 30;
    expect((await POST(post())).status).toBe(429);
    expect(h.diffuse).toBeNull();
    expect(h.pushed).toBeNull();
  });

  // Ce que ce test empêche : compter les messages DE TOUT LE MONDE. Avec `where: {}`, la
  // limite deviendrait un plafond de trente messages par dix minutes POUR LE CLUB ENTIER, et
  // les autres tests de ce bloc resteraient verts.
  it("compte les messages d'UN SEUL membre, sur une fenêtre glissante", async () => {
    await POST(post());
    expect(h.countWhere?.authorId).toBe("u1");
    const gte = (h.countWhere?.createdAt as { gte: Date }).gte;
    expect(Math.round((Date.now() - gte.getTime()) / 60_000)).toBe(10);
  });
});

describe("POST — purge des 12 mois", () => {
  it("balaie à chaque écriture, sans cron", async () => {
    await POST(post());
    const lt = (h.purge?.createdAt as { lt: Date }).lt;
    const jours = (Date.now() - lt.getTime()) / 86_400_000;
    expect(Math.round(jours)).toBe(365);
  });
});

describe("POST — diffusion et notification", () => {
  it("écrit AVANT de diffuser", async () => {
    await POST(post());
    expect(h.ordre).toEqual(["ecrit", "diffuse"]);
  });

  it("ne diffuse NI `canDelete` NI `mine` : ces droits dépendent de qui regarde", async () => {
    await POST(post());
    expect(h.diffuse?.[0]).toBe("message");
    expect(h.diffuse?.[1]).not.toHaveProperty("canDelete");
    expect(h.diffuse?.[1]).not.toHaveProperty("mine");
    expect(h.diffuse?.[1].id).toBe("m-neuf");
  });

  // La ligne diffusée doit être EXACTEMENT celle que le GET renvoie. Sans quoi un message reçu
  // en direct ne se comporte pas comme le même message après rechargement — c'est très
  // exactement le défaut qui alignait à gauche le message qu'on venait d'écrire.
  it("diffuse la MÊME forme de ligne que celle rendue par le GET", async () => {
    h.rows = [ligne()];
    const body = await (await GET(get())).json();
    await POST(post());
    expect(Object.keys(h.diffuse?.[1] ?? {}).sort()).toEqual(
      Object.keys(body.messages[0]).sort(),
    );
  });

  it("ne notifie NI l'auteur NI les comptes désactivés NI ceux qui ont coupé", async () => {
    await POST(post());
    expect(h.destWhere).toEqual({
      disabledAt: null,
      forumMuted: false,
      id: { not: "u1" },
    });
    expect(h.pushed?.[0]).toEqual(["u2", "u3"]);
  });

  it("regroupe sous UN SEUL tag, sinon une soirée animée fait trente notifications", async () => {
    await POST(post("Qui prend la voiture jeudi ?"));
    expect(h.pushed?.[1].tag).toBe("forum");
    // Sans `renotify`, la deuxième notification remplacerait la première EN SILENCE.
    expect(h.pushed?.[1].renotify).toBe(true);
    expect(h.pushed?.[1].body).toBe("Qui prend la voiture jeudi ?");
    expect(h.pushed?.[1].url).toBe("/?view=forum");
  });

  // LE DÉFAUT QUE CE TEST VERROUILLE : le corps du message était recopié dans une ligne
  // `AppNotification` PAR DESTINATAIRE, gardée 30 jours. Supprimer le message n'en retirait
  // aucune, et supprimer son compte n'effaçait que les copies dont il était le destinataire —
  // celles des autres, qui portent son nom et son texte, survivaient. Le push, lui, garde son
  // aperçu : il est transitoire, et c'est ce qui rend la notification utile.
  it("ne recopie PAS le message dans le journal de la cloche", async () => {
    await POST(post("Je ne veux pas de ça pendant trente jours chez trente personnes"));
    const journal = h.pushOpts?.journal as Record<string, unknown> | undefined;
    expect(journal).toBeTruthy();
    expect(JSON.stringify(journal)).not.toContain("trente personnes");
    expect(journal?.tag).toBe("forum");
    expect(journal?.url).toBe("/?view=forum");
  });
});

describe("GET — la page récente", () => {
  it("rend les messages du PLUS ANCIEN au plus récent, prêts à afficher", async () => {
    h.rows = [ligne({ id: "m2", createdAt: new Date("2026-09-05T19:00:00Z") }), ligne({ id: "m1" })];
    const body = await (await GET(get())).json();
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual(["m1", "m2"]);
    expect(body.hasMore).toBe(false);
  });

  it("annonce `hasMore` en lisant une ligne de plus que demandé", async () => {
    h.rows = Array.from({ length: 31 }, (_, i) => ligne({ id: `m${i}` }));
    const body = await (await GET(get())).json();
    expect(h.lastFindMany?.take).toBe(31);
    expect(body.messages).toHaveLength(30);
    expect(body.hasMore).toBe(true);
  });

  it("borne la limite demandée, pour qu'un ?limit=99999 ne rapatrie pas tout le fil", async () => {
    await GET(get("limit=99999"));
    expect(h.lastFindMany?.take).toBe(201);
  });

  it("donne l'identité du lecteur UNE fois, et aucun droit par ligne", async () => {
    h.rows = [ligne({ id: "a", authorId: "u1" }), ligne({ id: "b", authorId: "u2" })];
    const body = await (await GET(get())).json();
    expect(body.meId).toBe("u1");
    expect(body.admin).toBe(false);
    // C'est `authorId` qui permet au client de trancher, pas un booléen pré-calculé.
    expect(body.messages.map((m: { authorId: string }) => m.authorId)).toEqual(["u2", "u1"]);
    for (const m of body.messages) {
      expect(m).not.toHaveProperty("canDelete");
      expect(m).not.toHaveProperty("mine");
    }
  });

  // LE DÉFAUT QUE CE TEST VERROUILLE : `canDelete` valait `admin || auteur`, et l'écran s'en
  // servait pour aligner à droite. Un admin voyait donc TOUT le fil comme étant le sien.
  // Le drapeau d'admin est désormais SÉPARÉ de l'identité, et c'est le client qui compose.
  it("signale l'admin sans pour autant lui attribuer les messages des autres", async () => {
    h.session = { userId: "chef", displayName: "Chef", email: "chef@example.com" };
    h.rows = [ligne({ id: "a", authorId: "u1" }), ligne({ id: "b", authorId: "u2" })];
    const body = await (await GET(get())).json();
    expect(body.admin).toBe(true);
    expect(body.meId).toBe("chef");
    expect(body.messages.every((m: { authorId: string }) => m.authorId !== "chef")).toBe(true);
  });

  it("reconnaît l'admin quelle que soit la casse de son adresse", async () => {
    h.session = { userId: "chef", displayName: "Chef", email: "CHEF@Example.com" };
    expect((await (await GET(get())).json()).admin).toBe(true);
  });

  it("nomme l'auteur disparu au lieu de rendre « null »", async () => {
    h.rows = [ligne({ author: null })];
    const body = await (await GET(get())).json();
    expect(body.messages[0].authorName).toBe("Membre supprimé");
  });

  it("compose la citation à partir de la JOINTURE, sans rien lire dans la ligne elle-même", async () => {
    h.rows = [
      ligne({
        id: "b",
        replyToId: "a",
        replyTo: { body: "Covoit jeudi", author: { displayName: "Gégé" } },
      }),
    ];
    const body = await (await GET(get())).json();
    expect(body.messages[0].replyToAuthor).toBe("Gégé");
    expect(body.messages[0].replyToExcerpt).toBe("Covoit jeudi");
  });

  // LE DÉFAUT QUE CE TEST VERROUILLE : le nom et l'extrait de la cible étaient DÉNORMALISÉS
  // dans la ligne de la réponse. Ni la purge des 12 mois ni la cascade de suppression d'un
  // compte ne les atteignaient, et le GET les servait quand même — la notice promettait
  // pourtant que tout disparaît. La jointure rend la promesse vraie par construction.
  it("ne rend RIEN de la cible quand elle a disparu — ni nom, ni texte, ni clé", async () => {
    // `SET NULL` a déjà remis la clé à zéro en base ; la jointure ne rend rien non plus.
    h.rows = [ligne({ id: "b", replyToId: null, replyTo: null })];
    const body = await (await GET(get())).json();
    expect(body.messages[0].replyToId).toBeNull();
    expect(body.messages[0].replyToAuthor).toBeNull();
    expect(body.messages[0].replyToExcerpt).toBeNull();
  });

  // Ceinture : si la clé survivait sans sa cible, il ne faudrait pas afficher une citation vide.
  it("neutralise la clé quand la jointure ne rend rien", async () => {
    h.rows = [ligne({ id: "b", replyToId: "a", replyTo: null })];
    const body = await (await GET(get())).json();
    expect(body.messages[0].replyToId).toBeNull();
  });
});

describe("POST — la citation", () => {
  it("n'écrit QUE la clé, et rien du texte que le client prétend citer", async () => {
    h.cible = { id: "a" };
    await POST(post("Je prends une place", { replyTo: "a", replyToExcerpt: "MENSONGE" }));
    expect(h.cree?.replyToId).toBe("a");
    // Aucune colonne de texte cité n'existe plus : ni celle du client, ni une relue en base.
    // C'est ce qui fait qu'aucune parole ne se duplique dans la ligne de quelqu'un d'autre.
    expect(Object.keys(h.cree ?? {}).sort()).toEqual(["authorId", "body", "replyToId"]);
  });

  // Perdre le contexte d'une réponse est moins grave que perdre la réponse : une cible purgée
  // ou effacée entre l'ouverture du fil et l'envoi ne doit pas faire échouer l'écriture.
  it("envoie quand même le message si la cible a disparu", async () => {
    h.cible = null;
    const res = await POST(post("Je prends une place", { replyTo: "disparu" }));
    expect(res.status).toBe(201);
    expect(h.cree?.replyToId).toBeNull();
  });

  it("écrit un message ordinaire quand `replyTo` est absent ou vide", async () => {
    await POST(post("Coucou", { replyTo: "" }));
    expect(h.cree?.replyToId).toBeNull();
  });
});

describe("GET — le rattrapage après une coupure", () => {
  it("ne rend QUE ce qui a été écrit depuis l'ancre, dans l'ordre", async () => {
    h.since = { id: "m1", createdAt: new Date("2026-09-05T18:00:00Z") };
    h.rows = [ligne({ id: "m2" })];
    const body = await (await GET(get("since=m1"))).json();
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual(["m2"]);
    expect(body.complet).toBe(false);
  });

  // `createdAt` est un `TIMESTAMP(3)` : deux messages écrits dans la même milliseconde — deux
  // clics simultanés un soir de convocation — partagent la même valeur. Un `>` strict sur la
  // seule date en saute un DÉFINITIVEMENT, et rien ne le rattrape jamais. La borne et le tri
  // portent donc tous deux sur la paire (date, identifiant).
  it("départage deux messages de la MÊME milliseconde par leur identifiant", async () => {
    h.since = { id: "m1", createdAt: new Date("2026-09-05T18:00:00Z") };
    h.rows = [ligne({ id: "m2" })];
    await GET(get("since=m1"));
    expect(h.lastFindMany?.where).toEqual({
      OR: [
        { createdAt: { gt: h.since.createdAt } },
        { createdAt: h.since.createdAt, id: { gt: "m1" } },
      ],
    });
    expect(h.lastFindMany?.orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
  });

  // LE DÉFAUT QUE CE TEST VERROUILLE : le rattrapage ne portait QUE les messages neufs. Or
  // réagir, voter et supprimer ne créent aucun message. Sur le chemin même pour lequel le
  // rattrapage existe — courtier absent, retour au premier plan — aucun des trois n'arrivait
  // jamais, et l'écran restait faux jusqu'au démontage du composant.
  it("porte aussi la FENÊTRE VISIBLE, pour les gestes qui ne créent pas de message", async () => {
    h.since = { id: "m1", createdAt: new Date("2026-09-05T18:00:00Z") };
    h.rows = [ligne({ id: "m9" })];
    h.fenetre = [
      { id: "m9", createdAt: new Date("2026-09-05T19:00:00Z") },
      { id: "m7", createdAt: new Date("2026-09-05T17:00:00Z") },
    ];
    const body = await (await GET(get("since=m1"))).json();
    // `m7` n'est pas neuf : sans lui dans la fenêtre, une réaction posée dessus pendant la
    // coupure ne serait jamais rapatriée.
    expect(body.fenetre.ids).toEqual(["m9", "m7"]);
    expect(body.fenetre.depuis).toBe(new Date("2026-09-05T17:00:00Z").toISOString());
  });

  it("charge les réactions et les sondages de la fenêtre, pas des seuls messages neufs", async () => {
    h.since = { id: "m1", createdAt: new Date("2026-09-05T18:00:00Z") };
    h.rows = [ligne({ id: "m9" })];
    h.fenetre = [
      { id: "m9", createdAt: new Date("2026-09-05T19:00:00Z") },
      { id: "m7", createdAt: new Date("2026-09-05T17:00:00Z") },
    ];
    await GET(get("since=m1"));
    expect(h.reacIds).toEqual(["m9", "m7"]);
    expect(h.pollIds).toEqual(["m9", "m7"]);
  });

  it("renvoie `meName` en rattrapage — sinon le membre s'appelle « Moi »", async () => {
    h.since = { id: "m1", createdAt: new Date("2026-09-05T18:00:00Z") };
    const body = await (await GET(get("since=m1"))).json();
    expect(body.meName).toBe("Thomas");
    expect(body.meId).toBe("u1");
  });

  // Le message d'ancrage a pu être supprimé, ou purgé par les 12 mois, pendant la coupure.
  // Rendre une liste vide laisserait l'écran définitivement figé.
  it("retombe sur la page récente quand l'ancre a disparu, et le DIT", async () => {
    h.since = null;
    h.rows = [ligne({ id: "m9" })];
    const body = await (await GET(get("since=inconnu"))).json();
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual(["m9"]);
    expect(h.lastFindMany?.orderBy).toEqual({ createdAt: "desc" });
    // Sans ce drapeau, le client FUSIONNERAIT une page entière avec ce qu'il détient déjà.
    expect(body.complet).toBe(true);
  });

  // LE DÉFAUT QUE CE TEST VERROUILLE : `take: MAX_LIMIT` avec un tri ascendant gardait les 200
  // plus ANCIENS messages depuis l'ancre et répondait `hasMore: false`. Une absence d'une
  // semaine rendait les messages 1 à 200 et perdait les 60 derniers — ceux qui intéressent.
  it("renonce au rattrapage plutôt que de le tronquer en se déclarant complet", async () => {
    h.since = { id: "m1", createdAt: new Date("2026-09-05T18:00:00Z") };
    // 201 lignes : une de plus que la borne, ce qui est le signal de débordement.
    h.rows = Array.from({ length: 201 }, (_, i) => ligne({ id: `m${i}` }));
    const body = await (await GET(get("since=m1"))).json();
    expect(body.complet).toBe(true);
    expect(h.lastFindMany?.orderBy).toEqual({ createdAt: "desc" });
  });
});

// OPT-OUT et non opt-in, contrairement au suivi d'une équipe : un fil de club que personne ne
// reçoit ne vit pas. Mais la note de confidentialité promet que le réglage existe et se trouve
// « depuis le fil lui-même » — ces tests sont ce qui rend la phrase vraie.
describe("PATCH — couper les notifications du fil", () => {
  it("404 quand la fonction est coupée, avant de regarder la session", async () => {
    h.forumOn = false;
    h.session = null;
    expect((await PATCH(post())).status).toBe(404);
  });

  it("401 quand personne n'est connecté", async () => {
    h.session = null;
    expect((await PATCH(post())).status).toBe(401);
  });

  it("coupe, puis rétablit", async () => {
    const couper = {
      cookies: { get: () => ({ value: "sid" }) },
      json: async () => ({ muted: true }),
    } as unknown as NextRequest;
    expect((await PATCH(couper)).status).toBe(200);
    expect(h.regle).toEqual({ forumMuted: true });

    const retablir = {
      cookies: { get: () => ({ value: "sid" }) },
      json: async () => ({ muted: false }),
    } as unknown as NextRequest;
    await PATCH(retablir);
    expect(h.regle).toEqual({ forumMuted: false });
  });

  it("refuse autre chose qu'un booléen, au lieu d'écrire une valeur douteuse", async () => {
    const res = await PATCH(post("oui"));
    expect(res.status).toBe(400);
    expect(h.regle).toBeNull();
  });

  it("la page rend l'état du réglage, pour que l'écran ne le devine pas", async () => {
    h.muted = true;
    const body = await (await GET(get())).json();
    expect(body.muted).toBe(true);
  });
});
