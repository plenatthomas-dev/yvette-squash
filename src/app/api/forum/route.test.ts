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
//  4. L'EXTRAIT D'UNE CITATION EST RELU EN BASE, jamais repris du client — sinon n'importe
//     qui ferait dire n'importe quoi à n'importe qui, sous son nom, durablement.

const h = vi.hoisted(() => ({
  forumOn: true,
  session: { userId: "u1", displayName: "Thomas", email: "membre@example.com" } as {
    userId: string;
    displayName: string;
    email: string | null;
  } | null,
  recentCount: 0,
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
  since: null as null | { createdAt: Date },
  /** Le réglage « notifications coupées » du membre qui lit. */
  muted: false,
  /** Ce que le PATCH a écrit, ou null s'il n'a pas eu lieu. */
  regle: null as null | Record<string, unknown>,
  lastFindMany: null as null | Record<string, unknown>,
  /** La cible d'une citation, telle que la base la rendrait — ou `null` si elle a disparu. */
  cible: null as null | Record<string, unknown>,
  /** Les données passées à `forumMessage.create` : c'est là que se lit l'instantané cité. */
  cree: null as null | Record<string, unknown>,
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
  pushToUsers: vi.fn(async (ids: string[], payload: Record<string, unknown>) => {
    h.pushed = [ids, payload];
    return { recipients: ids.length, sent: ids.length };
  }),
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
      count: vi.fn(async () => h.recentCount),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        h.ordre.push("ecrit");
        h.cree = data;
        return {
          id: "m-neuf",
          body: data.body,
          authorId: data.authorId,
          createdAt: new Date("2026-09-05T18:42:00Z"),
          replyToId: data.replyToId ?? null,
          replyToAuthor: data.replyToAuthor ?? null,
          replyToExcerpt: data.replyToExcerpt ?? null,
          author: { displayName: "Thomas" },
        };
      }),
      findMany: vi.fn(async (args: Record<string, unknown>) => {
        h.lastFindMany = args;
        return h.rows;
      }),
      // Deux appelants : l'ancre du rattrapage (`select: { createdAt }`) et la cible d'une
      // citation (`select: { id, body, author }`). On les distingue sur le `select`, sinon
      // le test du rattrapage se ferait servir une cible de citation.
      findUnique: vi.fn(async (args: { select?: Record<string, unknown> }) =>
        args?.select?.body ? h.cible : h.since,
      ),
      deleteMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        h.purge = args.where;
        return { count: 0 };
      }),
    },
    // Les réactions et les sondages d'une page : vides par défaut, la plupart des tests ne
    // portent pas dessus. Ce sont DEUX requêtes, pas une par message — voir forum-db.ts.
    forumReaction: { findMany: vi.fn(async () => []) },
    forumPoll: { findMany: vi.fn(async () => []) },
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
  replyToAuthor: null,
  replyToExcerpt: null,
  author: { displayName: "Gégé" },
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

  it("porte la citation jusqu'à l'écran, extrait compris", async () => {
    h.rows = [
      ligne({ id: "b", replyToId: "a", replyToAuthor: "Gégé", replyToExcerpt: "Covoit jeudi" }),
    ];
    const body = await (await GET(get())).json();
    expect(body.messages[0].replyToAuthor).toBe("Gégé");
    expect(body.messages[0].replyToExcerpt).toBe("Covoit jeudi");
  });

  // Une réponse dont la cible a été supprimée garde sa clé mais perd son instantané : c'est le
  // signal qui fait afficher « Message supprimé » plutôt qu'un texte que la notice dit effacé.
  it("distingue « ne répond à rien » de « répond à un message supprimé »", async () => {
    // `h.rows` est servi du plus RÉCENT au plus ancien, comme la base : la réponse d'abord.
    h.rows = [ligne({ id: "b", replyToId: "a" }), ligne({ id: "a" })];
    const body = await (await GET(get())).json();
    expect(body.messages[0].replyToId).toBeNull();
    expect(body.messages[1].replyToId).toBe("a");
    expect(body.messages[1].replyToExcerpt).toBeNull();
  });
});

describe("POST — la citation", () => {
  it("relit la cible EN BASE et ignore ce que le client prétend", async () => {
    h.cible = { id: "a", body: "Covoit jeudi : 4 places", author: { displayName: "Gégé" } };
    await POST(post("Je prends une place", { replyTo: "a", replyToExcerpt: "MENSONGE" }));
    expect(h.cree?.replyToId).toBe("a");
    expect(h.cree?.replyToAuthor).toBe("Gégé");
    expect(h.cree?.replyToExcerpt).toBe("Covoit jeudi : 4 places");
  });

  // Perdre le contexte d'une réponse est moins grave que perdre la réponse : une cible purgée
  // ou effacée entre l'ouverture du fil et l'envoi ne doit pas faire échouer l'écriture.
  it("envoie quand même le message si la cible a disparu", async () => {
    h.cible = null;
    const res = await POST(post("Je prends une place", { replyTo: "disparu" }));
    expect(res.status).toBe(201);
    expect(h.cree?.replyToId).toBeUndefined();
  });

  it("écrit un message ordinaire quand `replyTo` est absent ou vide", async () => {
    await POST(post("Coucou", { replyTo: "" }));
    expect(h.cree?.replyToId).toBeUndefined();
  });
});

describe("GET — le rattrapage après une coupure", () => {
  it("ne rend QUE ce qui a été écrit depuis l'ancre, dans l'ordre", async () => {
    h.since = { createdAt: new Date("2026-09-05T18:00:00Z") };
    h.rows = [ligne({ id: "m2" })];
    const body = await (await GET(get("since=m1"))).json();
    expect(h.lastFindMany?.where).toEqual({ createdAt: { gt: h.since.createdAt } });
    expect(h.lastFindMany?.orderBy).toEqual({ createdAt: "asc" });
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual(["m2"]);
  });

  // Le message d'ancrage a pu être supprimé, ou purgé par les 12 mois, pendant la coupure.
  // Rendre une liste vide laisserait l'écran définitivement figé.
  it("retombe sur la page récente quand l'ancre a disparu", async () => {
    h.since = null;
    h.rows = [ligne({ id: "m9" })];
    const body = await (await GET(get("since=inconnu"))).json();
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual(["m9"]);
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
