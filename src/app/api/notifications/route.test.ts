import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  session: null as null | { userId: string },
  rows: [] as Array<Record<string, unknown>>,
  updated: null as null | Record<string, unknown>,
  take: 0,
  deleted: null as null | Record<string, unknown>,
}));

vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    appNotification: {
      findMany: vi.fn(async (args: { take: number }) => {
        h.take = args.take;
        return h.rows;
      }),
      updateMany: vi.fn(async (args: Record<string, unknown>) => {
        h.updated = args;
        return { count: 3 };
      }),
      deleteMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        h.deleted = args.where;
        return { count: 7 };
      }),
    },
  },
}));

import { GET, POST, DELETE } from "./route";

const req = (scope?: string) =>
  ({
    cookies: { get: () => undefined },
    nextUrl: { searchParams: new URLSearchParams(scope ? { scope } : {}) },
  }) as unknown as NextRequest;
const row = (over: Record<string, unknown> = {}) => ({
  id: "n1",
  title: "Équipe 1 – Massy",
  body: "Tom gagne 3-1",
  url: "/?view=interclub",
  tag: null,
  createdAt: new Date("2026-09-03T20:00:00Z"),
  readAt: null,
  ...over,
});

beforeEach(() => {
  h.session = { userId: "u1" };
  h.rows = [];
  h.updated = null;
  h.take = 0;
  h.deleted = null;
});

describe("GET /api/notifications", () => {
  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await GET(req())).status).toBe(401);
  });

  it("renvoie la liste ET le compte de non lues en une seule requête", async () => {
    h.rows = [row(), row({ id: "n2", readAt: new Date() })];
    const body = await (await GET(req())).json();
    expect(body.items).toHaveLength(2);
    expect(body.unread).toBe(1);
    expect(body.items[0]).toMatchObject({ id: "n1", read: false });
    expect(body.items[1]).toMatchObject({ id: "n2", read: true });
  });

  // La fenêtre LUE est plus large que la liste RENDUE : elle est repliée par `tag`, et une
  // soirée de rencontre produit une vingtaine de lignes pour une seule série. Lire large ne
  // coûte rien (c'est la requête qui coûte, pas les lignes) ; rendre large ferait un historique.
  it("lit une fenêtre large mais ne rend qu'une cloche", async () => {
    h.rows = Array.from({ length: 120 }, (_, i) => row({ id: `n${i}`, tag: null }));
    const body = await (await GET(req())).json();
    expect(h.take).toBe(120);
    expect(body.items).toHaveLength(30);
  });

  // `tag` était écrit à chaque notification et relu par personne, alors que le schéma promet
  // qu'il « regroupe une série ». Une soirée à quatre matchs remplissait la cloche à elle seule.
  it("replie une série de même tag en une entrée, en disant combien elle représente", async () => {
    h.rows = [
      row({ id: "a1", tag: "interclub-f1" }),
      row({ id: "a2", tag: "interclub-f1", readAt: new Date() }),
      row({ id: "a3", tag: "interclub-f1", readAt: new Date() }),
      row({ id: "b1", tag: "annonce" }),
    ];
    const body = await (await GET(req())).json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({ id: "a1", count: 3, read: false });
    expect(body.items[1]).toMatchObject({ id: "b1", count: 1 });
    // Deux séries non lues, et non quatre lignes : la pastille compte ce qui est affiché.
    expect(body.unread).toBe(2);
  });

  // Une série reste non lue tant qu'il y reste une ligne non lue : sinon la pastille
  // retomberait à zéro alors que le membre n'a rien vu.
  it("ne déclare une série lue que si TOUTES ses lignes le sont", async () => {
    h.rows = [
      row({ id: "a1", tag: "s", readAt: new Date() }),
      row({ id: "a2", tag: "s", readAt: null }),
    ];
    const body = await (await GET(req())).json();
    expect(body.items[0]).toMatchObject({ count: 2, read: false });
    expect(body.unread).toBe(1);
  });

  // Sans tag, pas de série : deux notifications isolées restent deux lignes.
  it("ne regroupe jamais deux notifications sans tag", async () => {
    h.rows = [row({ id: "a", tag: null }), row({ id: "b", tag: null })];
    const body = await (await GET(req())).json();
    expect(body.items).toHaveLength(2);
  });

  it("n'expose pas d'objet Date brut mais une chaîne ISO", async () => {
    h.rows = [row()];
    const body = await (await GET(req())).json();
    expect(typeof body.items[0].at).toBe("string");
  });
});

describe("POST /api/notifications", () => {
  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await POST(req())).status).toBe(401);
  });

  it("ne marque comme lues que MES notifications non lues", async () => {
    await POST(req());
    expect(h.updated).toMatchObject({ where: { userId: "u1", readAt: null } });
  });
});

describe("DELETE /api/notifications", () => {
  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await DELETE(req())).status).toBe(401);
  });

  it("sans portée, vide tout — y compris le non lu", async () => {
    const body = await (await DELETE(req())).json();
    expect(h.deleted).toEqual({ userId: "u1" });
    expect(body.removed).toBe(7);
  });

  it("avec scope=read, ne touche qu'à ce qui a déjà été vu", async () => {
    await DELETE(req("read"));
    expect(h.deleted).toEqual({ userId: "u1", readAt: { not: null } });
  });

  it("n'efface jamais les notifications d'un autre membre", async () => {
    await DELETE(req("read"));
    expect((h.deleted as { userId: string }).userId).toBe("u1");
  });
});
