import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// UNE ROUTE À UNE SEULE RÈGLE — et c'est justement pour ça qu'il fallait la tester.
//
// « Supprime SON propre commentaire » : tout tient dans la comparaison `comment.userId !==
// session.userId`. La retirer ne casserait rien de visible — l'interface, elle, ne montre le
// bouton qu'à l'auteur (`canDelete` calculé par `GET /api/tricount`). Le trou ne s'ouvrirait
// que pour qui appelle la route directement, c'est-à-dire exactement la situation contre
// laquelle un contrôle côté serveur existe.
//
// Le 404 plutôt que le 403 compte autant : répondre « interdit » confirmerait qu'un message
// existe à cet identifiant.

const h = vi.hoisted(() => ({
  session: null as null | { userId: string; displayName: string; resa: unknown },
  tricountOn: true,
  comment: null as null | { userId: string },
  del: vi.fn(async () => ({})),
}));

vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/features-server", () => ({ getFeatures: async () => ({ tricount: h.tricountOn }) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    tricountComment: { findUnique: vi.fn(async () => h.comment), delete: h.del },
  },
}));

import { DELETE } from "./route";

const req = () => ({ cookies: { get: () => ({ value: "sid" }) } }) as unknown as NextRequest;
const ctx = { params: Promise.resolve({ id: "c1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  h.session = { userId: "u1", displayName: "Alice", resa: { accessToken: "t" } };
  h.tricountOn = true;
  h.comment = { userId: "u1" };
});

describe("DELETE /api/tricount/comments/[id]", () => {
  it("supprime son propre message", async () => {
    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(200);
    expect(h.del).toHaveBeenCalledWith({ where: { id: "c1" } });
  });

  it("répond 404 sur le message d'un AUTRE, et ne supprime rien", async () => {
    h.comment = { userId: "u2" };
    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(404);
    expect(h.del).not.toHaveBeenCalled();
  });

  it("répond 404 — le même — sur un message inexistant", async () => {
    // Les deux refus sont indiscernables de l'extérieur : c'est voulu, sinon la différence
    // entre « pas à toi » et « n'existe pas » révélerait l'existence des messages des autres.
    h.comment = null;
    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(404);
    expect(h.del).not.toHaveBeenCalled();
  });

  it("répond 404 quand la fonction est coupée, sans lire la session", async () => {
    h.tricountOn = false;
    expect((await DELETE(req(), ctx)).status).toBe(404);
  });

  it("répond 401 sans session", async () => {
    h.session = null;
    const res = await DELETE(req(), ctx);
    expect(res.status).toBe(401);
    expect(h.del).not.toHaveBeenCalled();
  });
});
