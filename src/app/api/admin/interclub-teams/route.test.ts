import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// Cette route ne répartit plus les membres « en alternance » (outil de recette supprimé) :
// elle sert le roster des équipes et gère les joueurs SANS COMPTE. L'affectation des membres
// inscrits, elle, vit dans /api/admin/members (action "set_team").

const h = vi.hoisted(() => ({
  interclub: true,
  admin: null as null | { userId: string; email: string },
  teams: [] as Array<Record<string, unknown>>,
  /** Membres rattachés à une équipe, tels que `allTeamMembers` les relit. */
  members: [] as Array<Record<string, unknown>>,
  /** Le `where` de la requête des membres — pour vérifier ce qu'elle exclut. */
  whereMembres: null as null | Record<string, unknown>,
  guests: [] as Array<Record<string, unknown>>,
  team: null as null | Record<string, unknown>,
  created: null as null | Record<string, unknown>,
  deleted: 0,
  /** Force le `create` à échouer comme le ferait la contrainte @@unique([teamId, name]). */
  duplicate: false,
  updated: null as null | Record<string, unknown>,
  updatedCount: 1,
}));

vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({ interclub: h.interclub }),
}));
vi.mock("@/lib/admin", () => ({ requireAdmin: vi.fn(async () => h.admin) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        h.whereMembres = args.where;
        return h.members;
      }),
    },
    interclubTeam: {
      findMany: vi.fn(async () => h.teams),
      findUnique: vi.fn(async () => h.team),
    },
    interclubGuest: {
      findMany: vi.fn(async () => h.guests),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        if (h.duplicate) {
          const { Prisma } = await import("@prisma/client");
          throw new Prisma.PrismaClientKnownRequestError("unique", {
            code: "P2002",
            clientVersion: "test",
          });
        }
        h.created = args.data;
        return { id: "g-new", ...args.data };
      }),
      updateMany: vi.fn(async (args: { data: Record<string, unknown> }) => {
        h.updated = args.data;
        return { count: h.updatedCount };
      }),
      deleteMany: vi.fn(async () => ({ count: h.deleted })),
    },
  },
}));

import { GET, POST } from "./route";

const get = () => ({ cookies: { get: () => undefined } }) as unknown as NextRequest;
const post = (body: unknown) =>
  ({ cookies: { get: () => undefined }, json: async () => body }) as unknown as NextRequest;

beforeEach(() => {
  h.interclub = true;
  h.admin = { userId: "admin1", email: "admin@example.com" };
  h.teams = [{ id: "t1", name: "Équipe 1" }];
  h.members = [
    {
      id: "u1",
      teamId: "t1",
      displayName: "Jérôme Blanc",
      nickname: "Jéjé",
      interclubCltOverride: null,
      squashnetRanking: { clt: "5A", rangM: 412 },
    },
  ];
  h.whereMembres = null;
  h.guests = [{ id: "g1", teamId: "t1", name: "Paul Hors-Appli", clt: null }];
  h.team = { id: "t1", _count: { guests: 1 } };
  h.created = null;
  h.deleted = 1;
  h.duplicate = false;
  h.updated = null;
  h.updatedCount = 1;
});

describe("GET /api/admin/interclub-teams", () => {
  it("404 si la fonction est désactivée", async () => {
    h.interclub = false;
    expect((await GET(get())).status).toBe(404);
  });

  it("403 si l'appelant n'est pas admin", async () => {
    h.admin = null;
    expect((await GET(get())).status).toBe(403);
  });

  it("rend les équipes avec leur effectif inscrit, et les joueurs hors appli", async () => {
    const body = await (await GET(get())).json();
    expect(body.teams).toEqual([{ id: "t1", name: "Équipe 1", memberCount: 1 }]);
    expect(body.guests).toEqual([{ id: "g1", teamId: "t1", name: "Paul Hors-Appli", clt: null }]);
  });

  // L'écran s'appelle « effectif » : un décompte ne dit ni QUI en fait partie, ni à quel
  // classement il joue — or c'est le classement qui décide de l'ordre des simples. La liste
  // nominative des membres était pourtant absente de la réponse.
  it("rend les MEMBRES nominativement, avec leur classement effectif et leur équipe", async () => {
    const body = await (await GET(get())).json();
    expect(body.members).toEqual([
      { kind: "member", id: "u1", teamId: "t1", name: "Jéjé", clt: "5A", rangM: 412 },
    ]);
  });

  it("le classement d'un membre suit la correction admin quand il y en a une", async () => {
    h.members = [
      {
        id: "u1",
        teamId: "t1",
        displayName: "Jérôme Blanc",
        nickname: null,
        interclubCltOverride: "4D",
        squashnetRanking: { clt: "5A", rangM: 412 },
      },
    ];
    const body = await (await GET(get())).json();
    // La correction l'emporte sur le rapprochement, comme partout ailleurs (`memberClt`) — mais
    // le rang, lui, ne peut venir que de squashnet : une correction ne porte qu'un classement.
    expect(body.members[0]).toMatchObject({ clt: "4D", rangM: 412 });
  });

  it("exclut les comptes désactivés et les membres sans équipe", async () => {
    await GET(get());
    expect(h.whereMembres).toEqual({ teamId: { not: null }, disabledAt: null });
  });
});

describe("POST /api/admin/interclub-teams", () => {
  it("403 si l'appelant n'est pas admin", async () => {
    h.admin = null;
    expect((await POST(post({ action: "add_guest", teamId: "t1", name: "X" }))).status).toBe(403);
  });

  it("inscrit un joueur sans compte au roster d'une équipe", async () => {
    const res = await POST(post({ action: "add_guest", teamId: "t1", name: "Jean Dupont" }));
    expect(res.status).toBe(201);
    expect(h.created).toEqual({ teamId: "t1", name: "Jean Dupont", clt: null });
  });

  it("inscrit un joueur avec son classement, et le normalise en MAJUSCULES", async () => {
    const res = await POST(
      post({ action: "add_guest", teamId: "t1", name: "Jean Dupont", clt: "5b" }),
    );
    expect(res.status).toBe(201);
    expect(h.created).toMatchObject({ clt: "5B" });
  });

  it("refuse un classement mal formé à l'inscription", async () => {
    const res = await POST(
      post({ action: "add_guest", teamId: "t1", name: "Jean Dupont", clt: "cinq" }),
    );
    expect(res.status).toBe(400);
    expect(h.created).toBeNull();
  });

  // Sans normalisation, « Jean  Dupont » et « Jean Dupont » seraient deux joueurs distincts
  // et l'unicité par nom se contournerait d'une frappe.
  it("normalise les espaces du nom", async () => {
    await POST(post({ action: "add_guest", teamId: "t1", name: "  Jean   Dupont " }));
    expect(h.created?.name).toBe("Jean Dupont");
  });

  it("refuse un nom vide", async () => {
    expect((await POST(post({ action: "add_guest", teamId: "t1", name: "   " }))).status).toBe(400);
  });

  it("refuse une équipe inconnue", async () => {
    h.team = null;
    expect((await POST(post({ action: "add_guest", teamId: "tX", name: "Jean" }))).status).toBe(400);
  });

  it("traduit le doublon en 409 plutôt qu'en 500", async () => {
    h.duplicate = true;
    const res = await POST(post({ action: "add_guest", teamId: "t1", name: "Paul Hors-Appli" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/déjà/i);
  });

  it("borne le nombre de joueurs hors appli par équipe", async () => {
    h.team = { id: "t1", _count: { guests: 40 } };
    const res = await POST(post({ action: "add_guest", teamId: "t1", name: "Un de trop" }));
    expect(res.status).toBe(400);
    expect(h.created).toBeNull();
  });

  it("corrige le classement d'un invité déjà inscrit", async () => {
    const res = await POST(post({ action: "set_guest_clt", guestId: "g1", clt: "4d" }));
    expect(res.status).toBe(200);
    expect(h.updated).toEqual({ clt: "4D" });
  });

  it("efface le classement d'un invité avec une chaîne vide", async () => {
    const res = await POST(post({ action: "set_guest_clt", guestId: "g1", clt: "" }));
    expect(res.status).toBe(200);
    expect(h.updated).toEqual({ clt: null });
  });

  it("refuse un classement mal formé à la correction", async () => {
    const res = await POST(post({ action: "set_guest_clt", guestId: "g1", clt: "??" }));
    expect(res.status).toBe(400);
    expect(h.updated).toBeNull();
  });

  it("404 en corrigeant le classement d'un invité qui n'existe pas", async () => {
    h.updatedCount = 0;
    expect(
      (await POST(post({ action: "set_guest_clt", guestId: "gX", clt: "5A" }))).status,
    ).toBe(404);
  });

  it("retire un joueur du roster", async () => {
    const res = await POST(post({ action: "remove_guest", guestId: "g1" }));
    expect(res.status).toBe(200);
  });

  it("404 en retirant un joueur qui n'existe pas", async () => {
    h.deleted = 0;
    expect((await POST(post({ action: "remove_guest", guestId: "gX" }))).status).toBe(404);
  });

  it("refuse une action inconnue", async () => {
    expect((await POST(post({ action: "fill" }))).status).toBe(400);
  });
});
