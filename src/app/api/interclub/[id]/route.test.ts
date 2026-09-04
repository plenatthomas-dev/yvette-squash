import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// Les deux routes du DÉTAIL d'une rencontre. Elles n'étaient éprouvées nulle part, alors que
// l'une porte le SEUL 403 de toute la fonctionnalité (supprimer une rencontre, et en cascade
// tous ses matchs et tous leurs jeux) et l'autre écrit en base au passage d'une simple lecture.

const h = vi.hoisted(() => ({
  interclub: true,
  session: null as null | { userId: string; email: string },
  admins: "",
  fixture: null as null | Record<string, unknown>,
  /** Ce que le `updateMany` de l'auto-cicatrisation a reçu, ou `null` s'il n'a pas eu lieu. */
  healed: null as null | { where: Record<string, unknown>; data: Record<string, unknown> },
  deleted: null as null | string,
  members: [] as Array<Record<string, unknown>>,
  guests: [] as Array<Record<string, unknown>>,
  rosterWhere: null as null | Record<string, unknown>,
  /** Ce que le PATCH a écrit sur la rencontre. */
  patched: null as null | Record<string, unknown>,
  /** Les disponibilités effacées (le `where` du deleteMany), ou null s'il n'a pas eu lieu. */
  availabilityCleared: null as null | Record<string, unknown>,
  /** Arguments de `notifyFixtureMoved`, ou null : l'équipe a-t-elle été prévenue ? */
  moved: null as null | unknown[],
}));

vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({ interclub: h.interclub }),
}));
// `normalizeEmail` est réexporté ici pour `admin.ts`, qui s'en sert à lire l'allowlist : le
// mocker en no-op ferait passer le test de casse pour de mauvaises raisons.
vi.mock("@/lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session")>()),
  getSession: vi.fn(async () => h.session),
}));
vi.mock("@/lib/interclub-gate", () => ({ interclubChanged: vi.fn() }));
// Le déplacement d'une rencontre PRÉVIENT l'équipe. On mocke l'envoi (réseau) mais on vérifie
// qu'il part, et avec quoi : une rencontre déplacée en silence est exactement ce qui fait
// venir quelqu'un le mauvais jour.
vi.mock("@/lib/interclub-notify", () => ({
  notifyFixtureMoved: vi.fn(async (...args: unknown[]) => {
    h.moved = args;
  }),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    interclub: {
      findUnique: vi.fn(async () => h.fixture),
      updateMany: vi.fn(
        async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          h.healed = args;
          return { count: 1 };
        },
      ),
      delete: vi.fn(async (args: { where: { id: string } }) => {
        h.deleted = args.where.id;
        return {};
      }),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        h.patched = args.data;
        // La rencontre relue après écriture reflète la modification : c'est elle que la route
        // renvoie et qui alimente la notification de déplacement.
        h.fixture = { ...(h.fixture as Record<string, unknown>), ...args.data };
        return h.fixture;
      }),
    },
    interclubAvailability: {
      deleteMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        h.availabilityCleared = args.where;
        return { count: 2 };
      }),
    },
    // Le PATCH écrit dans une transaction : effacer les réponses et déplacer la rencontre
    // vont ensemble. Le mock exécute le corps sur les mêmes doubles.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        interclub: {
          update: vi.fn(async (args: { data: Record<string, unknown> }) => {
            h.patched = args.data;
            h.fixture = { ...(h.fixture as Record<string, unknown>), ...args.data };
            return h.fixture;
          }),
          findUnique: vi.fn(async () => h.fixture),
        },
        interclubAvailability: {
          deleteMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
            h.availabilityCleared = args.where;
            return { count: 2 };
          }),
        },
      }),
    user: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        h.rosterWhere = args.where;
        return h.members;
      }),
    },
    interclubGuest: { findMany: vi.fn(async () => h.guests) },
  },
}));

import { GET, PATCH, DELETE } from "./route";

const ctx = { params: Promise.resolve({ id: "f1" }) };
const req = () => ({ cookies: { get: () => undefined } }) as unknown as NextRequest;
/** Requête PATCH : même session, plus un corps JSON. */
const patchReq = (body: unknown) =>
  ({ cookies: { get: () => undefined }, json: async () => body }) as unknown as NextRequest;

/** Une rencontre telle que `interclubInclude` la rend : équipe, matchs, jeux, marqueur. */
const fixture = (over: Record<string, unknown> = {}) => ({
  id: "f1",
  date: "2026-09-03",
  teamId: "t1",
  team: { id: "t1", name: "Équipe 1" },
  season: null,
  division: null,
  opponent: "Massy",
  home: true,
  matchCount: 4,
  bestOf: 5,
  status: "scheduled",
  createdById: "u1",
  createdAt: new Date(),
  matches: [],
  ...over,
});

const match = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  order: 1,
  homeUserId: null,
  homeGuestId: null,
  homeDisplayName: "Tom",
  awayName: "Gégé",
  homeColor: null,
  awayColor: null,
  status: "pending",
  gamesHome: null,
  gamesAway: null,
  liveJson: null,
  scorerId: null,
  scorerClaimedAt: null,
  scorer: null,
  games: [],
  updatedAt: new Date("2026-09-03T19:30:00Z"),
  ...over,
});

beforeEach(() => {
  h.interclub = true;
  h.session = { userId: "u1", email: "membre@example.com" };
  process.env.ADMIN_EMAILS = "chef@example.com";
  h.fixture = fixture();
  h.healed = null;
  h.deleted = null;
  h.members = [];
  h.guests = [];
  h.rosterWhere = null;
  h.patched = null;
  h.availabilityCleared = null;
  h.moved = null;
});

describe("GET /api/interclub/{id} — gardes", () => {
  it("404 si la fonction est désactivée, avant même de regarder la session", async () => {
    h.interclub = false;
    h.session = null;
    expect((await GET(req(), ctx)).status).toBe(404);
  });

  it("401 si personne n'est connecté", async () => {
    h.session = null;
    expect((await GET(req(), ctx)).status).toBe(401);
  });

  it("404 si la rencontre n'existe pas", async () => {
    h.fixture = null;
    expect((await GET(req(), ctx)).status).toBe(404);
  });
});

describe("GET /api/interclub/{id} — roster servi", () => {
  // Le roster sert à REMPLIR le sélecteur de composition. S'il venait d'ailleurs que de
  // l'équipe qui dispute la rencontre, l'écran proposerait des joueurs que le serveur refusera
  // ensuite — la règle du club appliquée d'un seul côté n'en est plus une.
  it("est celui de l'équipe qui dispute la rencontre, comptes désactivés exclus", async () => {
    h.fixture = fixture({ teamId: "t7", team: { id: "t7", name: "Équipe 2" } });
    h.members = [{ id: "u9", displayName: "Jérôme Blanc", nickname: "Jéjé" }];
    h.guests = [{ id: "g1", name: "Paul Hors-Appli" }];
    const body = await (await GET(req(), ctx)).json();
    expect(h.rosterWhere).toEqual({ teamId: "t7", disabledAt: null });
    expect(body.roster).toEqual([
      { kind: "member", id: "u9", name: "Jéjé", clt: null, rangM: null },
      { kind: "guest", id: "g1", name: "Paul Hors-Appli", clt: null, rangM: null },
    ]);
  });
});

describe("GET /api/interclub/{id} — auto-cicatrisation du statut", () => {
  it("ne réécrit rien quand la colonne dit déjà la vérité", async () => {
    h.fixture = fixture({ status: "scheduled", matches: [match()] });
    await GET(req(), ctx);
    expect(h.healed).toBeNull();
  });

  it("recale la colonne quand elle a divergé du statut déduit", async () => {
    h.fixture = fixture({ status: "scheduled", matches: [match({ status: "live" })] });
    const body = await (await GET(req(), ctx)).json();
    expect(body.status).toBe("live");
    expect(h.healed?.data).toEqual({ status: "live" });
  });

  it("écrit SOUS CONDITION de la valeur lue, pour ne pas écraser une écriture concurrente", async () => {
    // On lit puis on écrit la même ligne hors transaction : entre les deux, un `PUT …/live` peut
    // avoir posé le vrai statut. Sans cette clause, ce simple lecteur l'écrasait avec une valeur
    // calculée sur un état déjà mort.
    h.fixture = fixture({ status: "scheduled", matches: [match({ status: "live" })] });
    await GET(req(), ctx);
    expect(h.healed?.where).toEqual({ id: "f1", status: "scheduled" });
  });
});

describe("DELETE /api/interclub/{id}", () => {
  it("404 si la fonction est désactivée", async () => {
    h.interclub = false;
    expect((await DELETE(req(), ctx)).status).toBe(404);
  });

  it("401 si personne n'est connecté", async () => {
    h.session = null;
    expect((await DELETE(req(), ctx)).status).toBe(401);
  });

  it("404 si la rencontre n'existe pas", async () => {
    h.fixture = null;
    expect((await DELETE(req(), ctx)).status).toBe(404);
    expect(h.deleted).toBeNull();
  });

  // LE SEUL 403 DE TOUTE LA FONCTIONNALITÉ. Tout le reste de l'interclub n'a qu'un rôle,
  // « membre connecté » ; supprimer une rencontre efface aussi ses matchs et tous leurs jeux,
  // et c'est le seul geste irréversible.
  it("403 pour un membre qui n'est ni le créateur ni un admin", async () => {
    h.session = { userId: "quidam", email: "quidam@example.com" };
    expect((await DELETE(req(), ctx)).status).toBe(403);
    expect(h.deleted).toBeNull();
  });

  it("laisse passer le créateur", async () => {
    h.session = { userId: "u1", email: "membre@example.com" };
    expect((await DELETE(req(), ctx)).status).toBe(200);
    expect(h.deleted).toBe("f1");
  });

  it("laisse passer un admin qui n'a pas créé la rencontre", async () => {
    h.session = { userId: "autre", email: "chef@example.com" };
    expect((await DELETE(req(), ctx)).status).toBe(200);
    expect(h.deleted).toBe("f1");
  });

  it("reconnaît l'admin quelle que soit la casse de son adresse", async () => {
    h.session = { userId: "autre", email: "CHEF@Example.com" };
    expect((await DELETE(req(), ctx)).status).toBe(200);
  });
});

// LE PATCH — la route qui manquait.
//
// Une rencontre créée n'était pas modifiable : seuls GET et DELETE existaient. Tant qu'on
// inscrivait une rencontre la veille au soir, supprimer et refaire suffisait. Depuis qu'un
// calendrier de saison entier est saisi en septembre et que la ligue reporte des journées,
// supprimer/recréer perdrait la composition ET les disponibilités déjà recueillies.
describe("PATCH /api/interclub/{id}", () => {
  it("404 si la fonction est désactivée", async () => {
    h.interclub = false;
    expect((await PATCH(patchReq({ date: "2026-10-16" }), ctx)).status).toBe(404);
  });

  it("403 pour qui n'est ni créateur ni admin", async () => {
    // Mêmes droits que DELETE, exactement : pas de règle nouvelle à retenir.
    h.session = { userId: "autre", email: "autre@example.com" };
    expect((await PATCH(patchReq({ opponent: "Massy 2" }), ctx)).status).toBe(403);
    expect(h.patched).toBeNull();
  });

  it("autorise un admin qui n'est pas le créateur", async () => {
    h.session = { userId: "autre", email: "chef@example.com" };
    expect((await PATCH(patchReq({ opponent: "Massy 2" }), ctx)).status).toBe(200);
    expect(h.patched).toMatchObject({ opponent: "Massy 2" });
  });

  it("404 sur une rencontre inconnue", async () => {
    h.fixture = null;
    expect((await PATCH(patchReq({ opponent: "X" }), ctx)).status).toBe(404);
  });

  it("refuse une date qui a la bonne FORME mais n'existe pas", async () => {
    // `2026-13-45` satisfait la forme, s'écrirait tel quel dans la colonne `String` et
    // remonterait en tête d'un tri lexicographique.
    expect((await PATCH(patchReq({ date: "2026-13-45" }), ctx)).status).toBe(400);
    expect(h.patched).toBeNull();
  });

  it("refuse une heure impossible, pas seulement mal formée", async () => {
    expect((await PATCH(patchReq({ time: "29:70" }), ctx)).status).toBe(400);
    expect((await PATCH(patchReq({ time: "20h30" }), ctx)).status).toBe(400);
    expect(h.patched).toBeNull();
  });

  it("normalise l'heure et accepte de l'effacer", async () => {
    await PATCH(patchReq({ time: "9:05" }), ctx);
    expect(h.patched).toMatchObject({ time: "09:05" });
    await PATCH(patchReq({ time: "" }), ctx);
    expect(h.patched).toMatchObject({ time: null });
  });

  it("enregistre lieu, adresse et journée", async () => {
    await PATCH(
      patchReq({ venue: "  SQUASH DE L YVETTE ", venueAddress: "1 rue du squash", round: "J7" }),
      ctx,
    );
    expect(h.patched).toMatchObject({
      venue: "SQUASH DE L YVETTE",
      venueAddress: "1 rue du squash",
    });
  });

  it("refuse un adversaire vidé — une rencontre sans adversaire ne veut rien dire", async () => {
    expect((await PATCH(patchReq({ opponent: "   " }), ctx)).status).toBe(400);
    expect(h.patched).toBeNull();
  });

  it("refuse un corps qui ne demande rien", async () => {
    expect((await PATCH(patchReq({}), ctx)).status).toBe(400);
  });

  it("DÉPLACER efface les réponses, réarme l'appel et prévient l'équipe", async () => {
    // « Je suis dispo le 9 » ne veut pas dire « je suis dispo le 16 ». Garder les réponses
    // ferait composer l'équipe sur des « oui » qui ne veulent plus rien dire — et ce sont
    // précisément les soirs de report qu'on se retrouve à trois.
    const res = await PATCH(patchReq({ date: "2026-10-16" }), ctx);
    expect(res.status).toBe(200);
    expect(h.availabilityCleared).toEqual({ interclubId: "f1" });
    expect(h.patched).toMatchObject({
      date: "2026-10-16",
      availabilityOpenedAt: null,
      availabilityRemindedAt: null,
    });
    expect(h.moved).not.toBeNull();
    // L'ANCIENNE date part avec : « déplacée au 16 » ne dit pas laquelle des trois rencontres
    // à venir a bougé, et c'est justement ce que le lecteur cherche.
    expect(h.moved?.[1]).toBe("2026-09-03");
  });

  it("ne touche NI aux réponses NI aux marqueurs quand la date ne bouge pas", async () => {
    await PATCH(patchReq({ date: "2026-09-03", venue: "Ailleurs" }), ctx);
    expect(h.availabilityCleared).toBeNull();
    expect(h.moved).toBeNull();
    expect(h.patched).not.toHaveProperty("availabilityOpenedAt");
  });

  it("ne prévient personne pour une simple correction de lieu", async () => {
    // Une notification par correction d'orthographe est le plus court chemin vers des
    // notifications coupées.
    await PATCH(patchReq({ venue: "Bon nom du club" }), ctx);
    expect(h.moved).toBeNull();
  });

  it("REFUSE de déplacer une rencontre déjà commencée", async () => {
    // Le déplacement efface les disponibilités et relance l'appel : cela n'a aucun sens sur
    // une soirée en cours ou jouée.
    h.fixture = fixture({ matches: [match({ status: "done", gamesHome: 3, gamesAway: 0 })] });
    const res = await PATCH(patchReq({ date: "2026-10-16" }), ctx);
    expect(res.status).toBe(409);
    expect(h.availabilityCleared).toBeNull();
    expect(h.patched).toBeNull();
  });

  it("laisse corriger le LIEU d'une rencontre commencée", async () => {
    // Ce qui est interdit, c'est de la déplacer — pas de réparer une faute de frappe.
    h.fixture = fixture({ matches: [match({ status: "done", gamesHome: 3, gamesAway: 0 })] });
    expect((await PATCH(patchReq({ venue: "Vrai club" }), ctx)).status).toBe(200);
    expect(h.patched).toMatchObject({ venue: "Vrai club" });
  });

  it("bascule une date prévisionnelle en date ferme", async () => {
    await PATCH(patchReq({ dateConfirmed: true }), ctx);
    expect(h.patched).toMatchObject({ dateConfirmed: true });
  });
});
