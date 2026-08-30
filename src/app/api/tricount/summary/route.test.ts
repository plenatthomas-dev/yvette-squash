import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// LA ROUTE APPELÉE À CHAQUE CHARGEMENT DE L'APPLI, PAR CHAQUE MEMBRE.
//
// Elle existe pour ne plus tirer l'historique complet — dépenses, parts, validations,
// commentaires, invités — afin d'en extraire deux entiers. C'est donc la route la plus appelée
// de la fonctionnalité, et elle n'avait aucun test : ni le 404 du drapeau coupé, ni le 401.
//
// Le calcul lui-même est éprouvé dans `tricount-summary.test.ts` ; ici on mesure les gardes et
// le fait que la réponse porte bien ce que le module a calculé, pour le membre CONNECTÉ.

const h = vi.hoisted(() => ({
  session: null as null | { userId: string; displayName: string; resa: unknown },
  tricountOn: true,
  summary: { globalCents: 0, owedCount: 0 },
  demandePour: null as null | string,
}));

vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/features-server", () => ({ getFeatures: async () => ({ tricount: h.tricountOn }) }));
vi.mock("@/lib/tricount-summary", () => ({
  tricountSummary: vi.fn(async (userId: string) => {
    h.demandePour = userId;
    return h.summary;
  }),
}));

import { GET } from "./route";

const req = () => ({ cookies: { get: () => ({ value: "sid" }) } }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  h.session = { userId: "u1", displayName: "Alice", resa: { accessToken: "t" } };
  h.tricountOn = true;
  h.summary = { globalCents: 0, owedCount: 0 };
  h.demandePour = null;
});

describe("GET /api/tricount/summary", () => {
  it("répond 404 quand la fonction est coupée, sans rien calculer", async () => {
    h.tricountOn = false;
    expect((await GET(req())).status).toBe(404);
    expect(h.demandePour).toBeNull();
  });

  it("répond 401 sans session, sans rien calculer", async () => {
    h.session = null;
    expect((await GET(req())).status).toBe(401);
    expect(h.demandePour).toBeNull();
  });

  it("rend les deux chiffres du membre CONNECTÉ, et rien d'autre", async () => {
    // Le corps est volontairement minuscule : c'est tout l'intérêt de cette route face à
    // `/api/tricount`, qu'elle remplace pour le badge €.
    h.summary = { globalCents: -4200, owedCount: 3 };
    const res = await GET(req());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ globalCents: -4200, owedCount: 3 });
    expect(h.demandePour).toBe("u1");
  });
});
