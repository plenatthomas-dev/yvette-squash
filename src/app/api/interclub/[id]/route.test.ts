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
    },
    user: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        h.rosterWhere = args.where;
        return h.members;
      }),
    },
    interclubGuest: { findMany: vi.fn(async () => h.guests) },
  },
}));

import { GET, DELETE } from "./route";

const ctx = { params: Promise.resolve({ id: "f1" }) };
const req = () => ({ cookies: { get: () => undefined } }) as unknown as NextRequest;

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
      { kind: "member", id: "u9", name: "Jéjé", clt: null },
      { kind: "guest", id: "g1", name: "Paul Hors-Appli", clt: null },
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
