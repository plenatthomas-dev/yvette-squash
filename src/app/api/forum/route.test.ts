import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// LE FIL DU CLUB — la route qui écrit et celle qui lit.
//
// Trois choses ne se relisent pas dans le code et sont donc verrouillées ici :
//  1. LE PUSH NE PART PAS À L'AUTEUR, ni à ceux qui l'ont coupé. Se notifier soi-même est le
//     défaut classique de toute messagerie, et il ne se voit qu'à l'usage.
//  2. LA DIFFUSION NE CONTIENT PAS `canDelete`. Ce droit dépend de QUI REGARDE : diffusé tel
//     quel, il donnerait à tout le monde le bouton « Suppr. » de l'auteur.
//  3. LE MESSAGE EST ÉCRIT AVANT D'ÊTRE DIFFUSÉ. L'ordre inverse ferait exister chez les
//     autres un message qui pourrait n'être jamais enregistré.

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
      create: vi.fn(async ({ data }: { data: { authorId: string; body: string } }) => {
        h.ordre.push("ecrit");
        return {
          id: "m-neuf",
          body: data.body,
          authorId: data.authorId,
          createdAt: new Date("2026-09-05T18:42:00Z"),
          author: { displayName: "Thomas" },
        };
      }),
      findMany: vi.fn(async (args: Record<string, unknown>) => {
        h.lastFindMany = args;
        return h.rows;
      }),
      findUnique: vi.fn(async () => h.since),
      deleteMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        h.purge = args.where;
        return { count: 0 };
      }),
    },
    user: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        h.destWhere = args.where;
        return h.destinataires;
      }),
      findUnique: vi.fn(async () => ({ forumMuted: h.muted })),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        h.regle = args.data;
        return {};
      }),
    },
  },
}));

import { GET, POST, PATCH } from "./route";

const post = (body: unknown = "Coucou 👍") =>
  ({
    cookies: { get: () => ({ value: "sid" }) },
    json: async () => ({ body }),
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

  it("ne diffuse PAS `canDelete` : ce droit dépend de qui regarde", async () => {
    await POST(post());
    expect(h.diffuse?.[0]).toBe("message");
    expect(h.diffuse?.[1]).not.toHaveProperty("canDelete");
    expect(h.diffuse?.[1].id).toBe("m-neuf");
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

  it("laisse l'auteur supprimer le sien, et personne d'autre", async () => {
    h.rows = [ligne({ id: "a", authorId: "u1" }), ligne({ id: "b", authorId: "u2" })];
    const body = await (await GET(get())).json();
    expect(body.messages.map((m: { canDelete: boolean }) => m.canDelete)).toEqual([false, true]);
  });

  it("laisse l'admin supprimer TOUS les messages : le fil est public, il lui faut un modérateur", async () => {
    h.session = { userId: "chef", displayName: "Chef", email: "chef@example.com" };
    h.rows = [ligne({ id: "a", authorId: "u1" }), ligne({ id: "b", authorId: "u2" })];
    const body = await (await GET(get())).json();
    expect(body.messages.every((m: { canDelete: boolean }) => m.canDelete)).toBe(true);
  });

  it("nomme l'auteur disparu au lieu de rendre « null »", async () => {
    h.rows = [ligne({ author: null })];
    const body = await (await GET(get())).json();
    expect(body.messages[0].authorName).toBe("Membre supprimé");
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
