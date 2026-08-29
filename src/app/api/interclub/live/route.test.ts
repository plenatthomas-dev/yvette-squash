import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// La route du bandeau « En direct ». Son contenu est éprouvé dans `interclub-gate.test.ts` ;
// ce qui se joue ICI et nulle part ailleurs, c'est l'enveloppe : l'ordre des deux gardes, et
// l'en-tête qui interdit à un cache PARTAGÉ de retenir une réponse authentifiée.

const h = vi.hoisted(() => ({
  interclub: true,
  session: null as null | { userId: string },
  fixtures: [] as Array<Record<string, unknown>>,
  sessionLue: false,
}));

vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({ interclub: h.interclub }),
}));
vi.mock("@/lib/session", () => ({
  getSession: vi.fn(async () => {
    h.sessionLue = true;
    return h.session;
  }),
}));
vi.mock("@/lib/interclub-gate", () => ({ getLiveFixtures: vi.fn(async () => h.fixtures) }));

import { GET } from "./route";

const req = () => ({ cookies: { get: () => undefined } }) as unknown as NextRequest;

beforeEach(() => {
  h.interclub = true;
  h.session = { userId: "u1" };
  h.fixtures = [];
  h.sessionLue = false;
});

describe("GET /api/interclub/live", () => {
  // 404 AVANT 401 : une fonction coupée doit répondre « rien ici », y compris à un visiteur non
  // connecté. Répondre 401 lui apprendrait qu'il existe quelque chose à cette adresse.
  it("404 si la fonction est désactivée, sans même lire la session", async () => {
    h.interclub = false;
    h.session = null;
    expect((await GET(req())).status).toBe(404);
    expect(h.sessionLue).toBe(false);
  });

  it("401 si personne n'est connecté", async () => {
    h.session = null;
    expect((await GET(req())).status).toBe(401);
  });

  it("rend les rencontres du jour à un membre connecté", async () => {
    h.fixtures = [{ id: "f1", teamName: "Équipe 1", opponent: "Massy", status: "live" }];
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).fixtures).toHaveLength(1);
  });

  // La réponse porte des noms de joueurs et n'est servie qu'à un membre. Un cache partagé
  // indexe l'URL, PAS le cookie : sans `no-store`, il servirait la soirée du club à la
  // première requête venue.
  it("interdit à tout cache partagé de retenir cette réponse authentifiée", async () => {
    const res = await GET(req());
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
