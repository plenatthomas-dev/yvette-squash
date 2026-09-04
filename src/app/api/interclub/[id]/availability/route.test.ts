import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// LES DISPONIBILITÉS D'UNE RENCONTRE.
//
// Deux choses valent qu'on les verrouille ici, parce qu'aucune ne se voit à la relecture :
//
//  1. L'écran part du ROSTER, pas des réponses. Ceux qui n'ont rien dit doivent apparaître —
//     ce sont eux qui intéressent le capitaine —, et parmi eux, ceux qu'AUCUNE relance
//     n'atteindra (joueurs sans compte, membres sans notifications) doivent être séparés :
//     relancer par notification quelqu'un qui n'en reçoit pas ne coûte rien mais ne produit
//     rien, et laisse croire que le travail est fait.
//
//  2. On peut répondre POUR quelqu'un d'autre — sinon l'outil ne sert à rien pour la moitié du
//     roster. La garantie n'est pas une restriction mais une trace (`setById`) et une
//     confirmation explicite avant d'écraser ce que quelqu'un a dit lui-même.

const h = vi.hoisted(() => ({
  interclub: true,
  session: null as null | { userId: string; email: string },
  fixture: null as null | Record<string, unknown>,
  /** Membres de l'équipe, tels que `user.findMany` les rend (avec `pushSubs`). */
  members: [] as Array<Record<string, unknown>>,
  guests: [] as Array<Record<string, unknown>>,
  answers: [] as Array<Record<string, unknown>>,
  /** L'utilisateur que `user.findUnique` rend (le demandeur, puis le sujet visé). */
  users: {} as Record<string, { teamId: string | null } | null>,
  guestById: {} as Record<string, { teamId: string } | null>,
  created: null as null | Record<string, unknown>,
  updated: null as null | { where: unknown; data: Record<string, unknown> },
}));

vi.mock("@/lib/features-server", () => ({ getFeatures: async () => ({ interclub: h.interclub }) }));
vi.mock("@/lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session")>()),
  getSession: vi.fn(async () => h.session),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    interclub: { findUnique: vi.fn(async () => h.fixture) },
    user: {
      findMany: vi.fn(async () => h.members),
      findUnique: vi.fn(async (args: { where: { id: string } }) => h.users[args.where.id] ?? null),
    },
    interclubGuest: {
      findMany: vi.fn(async () => h.guests),
      findUnique: vi.fn(async (args: { where: { id: string } }) => h.guestById[args.where.id] ?? null),
    },
    interclubAvailability: {
      findMany: vi.fn(async () => h.answers),
      findFirst: vi.fn(async () => h.answers.find((a) => a.__existing) ?? null),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        h.created = args.data;
        return args.data;
      }),
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        h.updated = args;
        return args.data;
      }),
    },
  },
}));

import { GET, PUT } from "./route";

const ctx = { params: Promise.resolve({ id: "f1" }) };
const req = (body?: unknown) =>
  ({ cookies: { get: () => undefined }, json: async () => body ?? {} }) as unknown as NextRequest;

/** Un membre de l'équipe, joignable par défaut. */
const membre = (id: string, name: string, joignable = true) => ({
  id,
  displayName: name,
  nickname: null,
  pushSubs: joignable ? [{ id: "s1" }] : [],
});

beforeEach(() => {
  h.interclub = true;
  h.session = { userId: "u1", email: "alice@ex.com" };
  h.fixture = { id: "f1", teamId: "t1", matchCount: 4, date: "2026-10-09" };
  h.members = [membre("u1", "Alice"), membre("u2", "Bob")];
  h.guests = [];
  h.answers = [];
  h.users = { u1: { teamId: "t1" }, u2: { teamId: "t1" } };
  h.guestById = {};
  h.created = null;
  h.updated = null;
});

describe("GET /api/interclub/{id}/availability", () => {
  it("404 quand l'interclub est coupé, avant même de regarder la rencontre", async () => {
    h.interclub = false;
    expect((await GET(req(), ctx)).status).toBe(404);
  });

  it("403 pour un membre d'une AUTRE équipe", async () => {
    // On parle de la disponibilité de gens qui jouent ensemble : quelqu'un qui ne dispute pas
    // cette rencontre n'a rien à y lire.
    h.users.u1 = { teamId: "t2" };
    expect((await GET(req(), ctx)).status).toBe(403);
  });

  it("403 pour un membre rattaché à aucune équipe", async () => {
    h.users.u1 = { teamId: null };
    expect((await GET(req(), ctx)).status).toBe(403);
  });

  it("liste TOUT le roster, y compris ceux qui n'ont rien répondu", async () => {
    // Partir des réponses enregistrées donnerait l'illusion d'une équipe complète : les
    // silencieux disparaîtraient, alors que ce sont eux qui intéressent le capitaine.
    const { entries } = await (await GET(req(), ctx)).json();
    expect(entries.map((e: { name: string; status: null }) => [e.name, e.status])).toEqual([
      ["Alice", null],
      ["Bob", null],
    ]);
  });

  it("mêle les joueurs SANS COMPTE au roster, triés avec les autres", async () => {
    h.guests = [{ id: "g1", name: "Aaron Hors-Appli" }];
    const { entries } = await (await GET(req(), ctx)).json();
    expect(entries.map((e: { name: string }) => e.name)).toEqual(["Aaron Hors-Appli", "Alice", "Bob"]);
    expect(entries[0]).toMatchObject({ key: "guest:g1", isMember: false, reachable: false });
  });

  it("dit qui est ATTEIGNABLE par notification", async () => {
    // Sans cette information, le capitaine relance en aveugle des gens que la relance
    // n'atteindra jamais.
    h.members = [membre("u1", "Alice", true), membre("u2", "Bob", false)];
    const { entries, counts } = await (await GET(req(), ctx)).json();
    expect(entries.find((e: { name: string }) => e.name === "Alice").reachable).toBe(true);
    expect(entries.find((e: { name: string }) => e.name === "Bob").reachable).toBe(false);
    expect(counts.pendingReachable.map((e: { name: string }) => e.name)).toEqual(["Alice"]);
    expect(counts.pendingUnreachable.map((e: { name: string }) => e.name)).toEqual(["Bob"]);
  });

  it("affiche « relayé par » UNIQUEMENT quand un tiers a saisi", async () => {
    // Sur une réponse de première main, afficher « relayé par Alice » à Alice n'apprendrait
    // rien et sèmerait le doute sur ce qu'elle a elle-même déclaré.
    h.answers = [
      { userId: "u1", guestId: null, status: "yes", comment: null, setById: "u1", setBy: { displayName: "Alice", nickname: null } },
      { userId: "u2", guestId: null, status: "no", comment: "en déplacement", setById: "u1", setBy: { displayName: "Alice", nickname: null } },
    ];
    const { entries } = await (await GET(req(), ctx)).json();
    expect(entries.find((e: { name: string }) => e.name === "Alice").relayedBy).toBeNull();
    expect(entries.find((e: { name: string }) => e.name === "Bob")).toMatchObject({
      status: "no",
      comment: "en déplacement",
      relayedBy: "Alice",
    });
  });

  it("compte les réponses et rappelle le nombre de simples à couvrir", async () => {
    h.answers = [
      { userId: "u1", guestId: null, status: "yes", comment: null, setById: "u1", setBy: { displayName: "Alice", nickname: null } },
    ];
    const { counts, matchCount } = await (await GET(req(), ctx)).json();
    expect(counts).toMatchObject({ yes: 1, no: 0, maybe: 0 });
    expect(matchCount).toBe(4);
  });
});

describe("PUT /api/interclub/{id}/availability", () => {
  it("enregistre ma propre réponse, signée de moi", async () => {
    const res = await PUT(req({ status: "yes", comment: "  je peux  " }), ctx);
    expect(res.status).toBe(200);
    expect(h.created).toMatchObject({
      interclubId: "f1",
      userId: "u1",
      guestId: null,
      status: "yes",
      comment: "je peux",
      setById: "u1",
    });
  });

  it("refuse un statut inventé", async () => {
    expect((await PUT(req({ status: "peut-être" }), ctx)).status).toBe(400);
    expect(h.created).toBeNull();
  });

  it("relaie la réponse d'un coéquipier, en gardant QUI l'a saisie", async () => {
    // Le cas qui justifie toute la fonctionnalité : Bob n'a pas activé les notifications, on
    // l'a eu au club, on consigne. `setById` est ce qui distingue « il a dit oui » de « on a
    // dit qu'il dirait oui ».
    await PUT(req({ status: "no", userId: "u2" }), ctx);
    expect(h.created).toMatchObject({ userId: "u2", setById: "u1", status: "no" });
  });

  it("relaie la réponse d'un joueur SANS COMPTE", async () => {
    h.guestById = { g1: { teamId: "t1" } };
    await PUT(req({ status: "yes", guestId: "g1" }), ctx);
    expect(h.created).toMatchObject({ guestId: "g1", userId: null, setById: "u1" });
  });

  it("refuse de répondre pour quelqu'un d'une autre équipe", async () => {
    h.users.u2 = { teamId: "t2" };
    expect((await PUT(req({ status: "yes", userId: "u2" }), ctx)).status).toBe(400);
    expect(h.created).toBeNull();
  });

  it("refuse un membre ET un joueur sans compte dans la même requête", async () => {
    const res = await PUT(req({ status: "yes", userId: "u2", guestId: "g1" }), ctx);
    expect(res.status).toBe(400);
    expect(h.created).toBeNull();
  });

  it("409 quand un tiers écrase une réponse de PREMIÈRE MAIN, en disant laquelle", async () => {
    // Le capitaine doit voir ce qu'il remplace. Un refus sec le laisserait croire à un bug ;
    // un remplacement silencieux ferait disparaître un « non » assumé.
    h.answers = [
      { __existing: true, id: "a1", userId: "u2", setById: "u2", status: "no", updatedAt: new Date("2026-10-01T10:00:00Z"), comment: null, guestId: null, setBy: { displayName: "Bob", nickname: null } },
    ];
    const res = await PUT(req({ status: "yes", userId: "u2" }), ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("confirm_override");
    expect(body.existing).toMatchObject({ status: "no" });
    expect(h.updated).toBeNull();
  });

  it("passe avec confirmOverride, et enregistre le nouveau signataire", async () => {
    h.answers = [
      { __existing: true, id: "a1", userId: "u2", setById: "u2", status: "no", updatedAt: new Date(), comment: null, guestId: null, setBy: { displayName: "Bob", nickname: null } },
    ];
    const res = await PUT(req({ status: "yes", userId: "u2", confirmOverride: true }), ctx);
    expect(res.status).toBe(200);
    expect(h.updated?.data).toMatchObject({ status: "yes", setById: "u1" });
  });

  it("l'intéressé se corrige SANS confirmation — c'est sa réponse", async () => {
    h.answers = [
      { __existing: true, id: "a1", userId: "u1", setById: "u1", status: "no", updatedAt: new Date(), comment: null, guestId: null, setBy: { displayName: "Alice", nickname: null } },
    ];
    const res = await PUT(req({ status: "yes" }), ctx);
    expect(res.status).toBe(200);
    expect(h.updated?.data).toMatchObject({ status: "yes" });
  });

  it("remplacer un relais par un autre ne demande rien : deux ouï-dire se valent", async () => {
    h.answers = [
      { __existing: true, id: "a1", userId: "u2", setById: "u3", status: "no", updatedAt: new Date(), comment: null, guestId: null, setBy: { displayName: "Chloé", nickname: null } },
    ];
    expect((await PUT(req({ status: "yes", userId: "u2" }), ctx)).status).toBe(200);
  });

  it("403 pour un membre d'une autre équipe, comme en lecture", async () => {
    h.users.u1 = { teamId: "t2" };
    expect((await PUT(req({ status: "yes" }), ctx)).status).toBe(403);
    expect(h.created).toBeNull();
  });
});
