import { describe, it, expect, beforeEach, vi } from "vitest";

// `destroySession` porte deux exigences qui tirent en sens inverse :
//  - sécurité : le `sid` du cookie doit toujours mourir (un cookie qui fuite ne rouvre rien) ;
//  - biométrie : les jetons ResaMania doivent SURVIVRE à la déconnexion, sinon la reprise par
//    passkey (`createResaSessionFromUser`) ne trouve plus rien et répond « connexion expirée ».
// D'où la ligne « dormante » à identifiant neuf. Ces tests verrouillent les deux.

const h = vi.hoisted(() => ({
  found: null as null | Record<string, unknown>,
  findUnique: vi.fn(),
  create: vi.fn(),
  del: vi.fn(),
}));

vi.mock("./db", () => ({
  prisma: {
    session: { findUnique: h.findUnique, create: h.create, delete: h.del },
  },
}));
vi.mock("./crypto", () => ({ encrypt: (v: string) => v, decrypt: (v: string) => v }));
vi.mock("./resamania/client", () => ({ ensureFresh: vi.fn() }));

import { destroySession } from "./session";

const RESA_ROW = {
  id: "sid-cookie",
  userId: "u1",
  accessToken: "enc-access",
  refreshTokenEnc: "enc-refresh",
  tokenExpiresAt: new Date("2026-08-15T10:00:00Z"),
  identityJson: '{"contactId":"/omafitness/contacts/1"}',
  expiresAt: new Date("2026-09-14T10:00:00Z"),
};

beforeEach(() => {
  h.found = RESA_ROW;
  h.findUnique.mockReset().mockImplementation(async () => h.found);
  h.create.mockReset().mockResolvedValue({});
  h.del.mockReset().mockResolvedValue({});
});

describe("destroySession", () => {
  it("supprime toujours la ligne du cookie (le sid ne doit plus rien ouvrir)", async () => {
    await destroySession("sid-cookie");
    expect(h.del).toHaveBeenCalledWith({ where: { id: "sid-cookie" } });
  });

  it("transfère les jetons ResaMania dans une ligne dormante à identifiant NEUF", async () => {
    await destroySession("sid-cookie");
    expect(h.create).toHaveBeenCalledTimes(1);
    const data = h.create.mock.calls[0][0].data;
    expect(data.userId).toBe("u1");
    expect(data.accessToken).toBe("enc-access");
    expect(data.refreshTokenEnc).toBe("enc-refresh");
    expect(data.identityJson).toBe(RESA_ROW.identityJson);
    // Identifiant neuf : réutiliser celui du cookie ressusciterait la session qu'on ferme.
    expect(data.id).not.toBe("sid-cookie");
    expect(typeof data.id).toBe("string");
    expect(data.id.length).toBeGreaterThan(20);
  });

  it("n'allonge pas la durée de vie : la réserve garde l'échéance d'origine", async () => {
    await destroySession("sid-cookie");
    expect(h.create.mock.calls[0][0].data.expiresAt).toEqual(RESA_ROW.expiresAt);
  });

  it("crée la réserve AVANT de supprimer (aucune fenêtre où les jetons sont perdus)", async () => {
    const order: string[] = [];
    h.create.mockImplementation(async () => void order.push("create"));
    h.del.mockImplementation(async () => void order.push("delete"));
    await destroySession("sid-cookie");
    expect(order).toEqual(["create", "delete"]);
  });

  it("session « email seul » (sans jeton) : rien à mettre en réserve", async () => {
    h.found = {
      id: "sid-cookie",
      userId: "u1",
      accessToken: null,
      refreshTokenEnc: null,
      tokenExpiresAt: null,
      identityJson: null,
      expiresAt: new Date("2026-09-14T10:00:00Z"),
    };
    await destroySession("sid-cookie");
    expect(h.create).not.toHaveBeenCalled();
    expect(h.del).toHaveBeenCalledWith({ where: { id: "sid-cookie" } });
  });

  it("la déconnexion aboutit même si la mise en réserve échoue", async () => {
    h.create.mockRejectedValue(new Error("base indisponible"));
    await expect(destroySession("sid-cookie")).resolves.toBeUndefined();
    expect(h.del).toHaveBeenCalledWith({ where: { id: "sid-cookie" } });
  });

  it("sans cookie, ou sur une session inconnue, ne touche à rien", async () => {
    await destroySession(undefined);
    h.found = null;
    await destroySession("sid-inexistant");
    expect(h.create).not.toHaveBeenCalled();
    expect(h.del).not.toHaveBeenCalled();
  });
});
