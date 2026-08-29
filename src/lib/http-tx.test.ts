import { describe, it, expect, beforeEach, vi } from "vitest";

// On simule le comportement de Postgres en Serializable : la première tentative échoue en
// P2034 autant de fois qu'on le demande, puis la transaction aboutit. C'est exactement le
// scénario que la boucle existe pour absorber.
const h = vi.hoisted(() => {
  // Doit vivre DANS le bloc hoisté : `vi.mock` est remonté en tête de fichier et ne peut pas
  // référencer une classe déclarée plus bas.
  class FauxPrismaError extends Error {
    code: string;
    constructor(code: string) {
      super(`erreur prisma ${code}`);
      this.code = code;
    }
  }
  return {
    FauxPrismaError,
    conflitsRestants: 0,
    appels: 0,
    jette: null as null | Error,
  };
});

const FauxPrismaError = h.FauxPrismaError;

vi.mock("@prisma/client", () => ({
  Prisma: {
    TransactionIsolationLevel: { Serializable: "Serializable" },
    PrismaClientKnownRequestError: h.FauxPrismaError,
  },
}));

vi.mock("./db", () => ({
  prisma: {
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => {
      h.appels += 1;
      if (h.conflitsRestants > 0) {
        h.conflitsRestants -= 1;
        throw new h.FauxPrismaError("P2034");
      }
      if (h.jette) throw h.jette;
      return run({});
    }),
  },
}));

import { HttpError, httpErrorResponse, serializableTransaction } from "./http-tx";

beforeEach(() => {
  h.conflitsRestants = 0;
  h.appels = 0;
  h.jette = null;
});

describe("serializableTransaction", () => {
  it("renvoie la valeur de la transaction quand tout se passe bien", async () => {
    const v = await serializableTransaction(async () => ({ id: "r1" }));
    expect(v).toEqual({ id: "r1" });
    expect(h.appels).toBe(1);
  });

  it("rejoue sur conflit de sérialisation, puis aboutit", async () => {
    h.conflitsRestants = 2;
    const v = await serializableTransaction(async () => "ok");
    expect(v).toBe("ok");
    expect(h.appels).toBe(3); // 2 conflits + la bonne
  });

  it("abandonne en 409 après quatre tentatives, avec le message fourni", async () => {
    h.conflitsRestants = 99;
    await expect(serializableTransaction(async () => "ok", "Prise concurrente")).rejects.toMatchObject(
      { status: 409, message: "Prise concurrente" },
    );
    expect(h.appels).toBe(4);
  });

  it("laisse passer du temps entre deux tentatives, sinon le compte d'essais ne veut rien dire", async () => {
    // Le plafond de quatre tentatives se justifie par « au-delà, c'est une contention durable ».
    // Le raisonnement suppose que du temps passe : sans recul, les quatre essais s'épuisaient en
    // quelques millisecondes et rendaient un 409 qu'une pause de rien du tout aurait évité.
    h.conflitsRestants = 3;
    const t0 = Date.now();
    await serializableTransaction(async () => "ok");
    expect(h.appels).toBe(4);
    expect(Date.now() - t0).toBeGreaterThan(0);
  });

  it("ne rejoue JAMAIS un refus métier — il se reproduirait à l'identique", async () => {
    let tours = 0;
    await expect(
      serializableTransaction(async () => {
        tours += 1;
        throw new HttpError(404, "Match introuvable");
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(tours).toBe(1);
  });

  it("laisse remonter une erreur inattendue sans la déguiser", async () => {
    h.jette = new Error("base injoignable");
    await expect(serializableTransaction(async () => "ok")).rejects.toThrow("base injoignable");
    expect(h.appels).toBe(1);
  });

  it("une erreur prisma d'un AUTRE code n'est pas un conflit", async () => {
    h.jette = new FauxPrismaError("P2002"); // violation de contrainte unique
    await expect(serializableTransaction(async () => "ok")).rejects.toMatchObject({ code: "P2002" });
    expect(h.appels).toBe(1);
  });
});

describe("httpErrorResponse", () => {
  it("traduit une HttpError en réponse JSON portant son statut", async () => {
    const res = httpErrorResponse(new HttpError(409, "Quelqu'un marque déjà ce match"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(409);
    await expect(res!.json()).resolves.toEqual({ error: "Quelqu'un marque déjà ce match" });
  });

  it("porte le code quand il y en a un, et rien de plus quand il n'y en a pas", async () => {
    // Deux refus peuvent partager un statut et appeler deux réactions opposées : c'est sur ce
    // code, jamais sur le texte, qu'un client doit brancher.
    const avec = httpErrorResponse(new HttpError(409, "Le score a changé ailleurs", "stale-games"));
    await expect(avec!.json()).resolves.toEqual({
      error: "Le score a changé ailleurs",
      code: "stale-games",
    });
    const sans = httpErrorResponse(new HttpError(409, "Quelqu'un marque déjà ce match"));
    await expect(sans!.json()).resolves.toEqual({ error: "Quelqu'un marque déjà ce match" });
  });

  it("renvoie null pour tout le reste, pour que le 500 et sa trace survivent", () => {
    expect(httpErrorResponse(new Error("bug"))).toBeNull();
    expect(httpErrorResponse("pas une erreur")).toBeNull();
    expect(httpErrorResponse(null)).toBeNull();
  });
});
