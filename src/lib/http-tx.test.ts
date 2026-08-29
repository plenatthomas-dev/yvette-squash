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
    dernieresOptions: undefined as undefined | Record<string, unknown>,
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
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>, opts?: unknown) => {
      h.appels += 1;
      h.dernieresOptions = opts as Record<string, unknown> | undefined;
      if (h.conflitsRestants > 0) {
        h.conflitsRestants -= 1;
        throw new h.FauxPrismaError("P2034");
      }
      if (h.jette) throw h.jette;
      return run({});
    }),
  },
}));

import {
  backoffFor,
  HttpError,
  httpErrorResponse,
  readJsonBody,
  serializableTransaction,
} from "./http-tx";

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

describe("backoffFor — la borne annoncée est un chiffre, pas une intention", () => {
  // Le test voisin (« laisse passer du temps ») n'éprouve rien : `expect(Date.now() - t0)
  // .toBeGreaterThan(0)` passerait à l'identique si le recul valait toujours zéro — ce que trois
  // tirages de `Math.random` autorisent d'ailleurs. On mesure donc la fonction elle-même.
  it("ne dépasse jamais 20 ms par tentative, soit 60 ms avant la dernière", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    expect(backoffFor(1)).toBeLessThanOrEqual(20);
    expect(backoffFor(2)).toBeLessThanOrEqual(40);
    expect(backoffFor(3)).toBeLessThanOrEqual(60);
    // Cumul au pire avant la quatrième et dernière tentative.
    expect(backoffFor(1) + backoffFor(2) + backoffFor(3)).toBeLessThanOrEqual(120);
    vi.restoreAllMocks();
  });

  it("croît avec le numéro de tentative", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(backoffFor(3)).toBeGreaterThan(backoffFor(1));
    vi.restoreAllMocks();
  });

  it("est TIRÉ AU SORT : deux écrivains en conflit ne doivent pas rejouer en cadence", () => {
    // Sans tirage, deux transactions concurrentes se retrouvent au même instant à chaque tour.
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(backoffFor(3)).toBe(0);
    vi.restoreAllMocks();
  });
});

describe("readJsonBody — un corps valide mais absurde ne doit pas sortir en 500", () => {
  const req = (json: () => Promise<unknown>) => ({ json });

  it("rend l'objet quand c'en est un", async () => {
    expect(await readJsonBody(req(async () => ({ a: 1 })))).toEqual({ a: 1 });
  });

  it("rend {} sur `null`, qui est du JSON parfaitement valide", async () => {
    // C'est le cas qui cassait : `json()` résolvait, puis la déstructuration levait
    // « Cannot destructure property of null » — un 500 non géré là où toute autre malformation
    // finissait en 400 propre.
    expect(await readJsonBody(req(async () => null))).toEqual({});
  });

  it("rend {} sur une primitive", async () => {
    expect(await readJsonBody(req(async () => 5))).toEqual({});
    expect(await readJsonBody(req(async () => "x"))).toEqual({});
    expect(await readJsonBody(req(async () => true))).toEqual({});
  });

  it("rend {} sur un corps illisible, comme avant", async () => {
    expect(await readJsonBody(req(async () => { throw new SyntaxError("Unexpected token"); }))).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEUX SOUPÇONS, MIS SOUS TEST PLUTÔT QUE CORRIGÉS.
//
// Ces tests ne prouvent pas qu'il y a un défaut : ils PINGLENT le comportement actuel, pour que
// la question posée soit vérifiable et que la réponse, quand elle viendra, se voie. Corriger
// sans savoir serait aussi mal fondé que de ne rien faire.
// ─────────────────────────────────────────────────────────────────────────────

describe("SOUPÇON — quels échecs sont rejoués, et lesquels ne le sont pas", () => {
  // `PUT …/live` justifie sa transaction Serializable par le fait que deux écritures
  // simultanées « violeraient `@@unique([matchId, number])` ». Or Postgres peut lever la
  // violation d'unicité (23505 → P2002) AVANT de détecter l'échec de sérialisation
  // (40001 → P2034) : le motif « supprimer puis réinsérer » peut sortir par l'une ou l'autre.
  //
  // Ce que ce test établit : le code ne rejoue QUE P2034. Si Postgres choisit P2002, la route
  // rend un 500 au lieu de réessayer. Reste à savoir lequel des deux il choisit réellement sur
  // ce motif — ce qui demande deux transactions concurrentes sur une vraie base.
  it("rejoue P2034 — le conflit de sérialisation", async () => {
    h.conflitsRestants = 2;
    await expect(serializableTransaction(async () => "ok")).resolves.toBe("ok");
    expect(h.appels).toBe(3);
  });

  it("ne rejoue PAS P2002 — la violation d'unicité, qu'un delete-then-insert peut produire", async () => {
    h.jette = new FauxPrismaError("P2002");
    await expect(serializableTransaction(async () => "ok")).rejects.toMatchObject({ code: "P2002" });
    expect(h.appels).toBe(1);
  });

  it("ne rejoue PAS P2028 — l'expiration de transaction", async () => {
    // Conséquence du second soupçon : sans `timeout`, une transaction longue sort en P2028, qui
    // n'est pas un conflit de sérialisation, donc n'est pas rejouée, donc sort en 500.
    h.jette = new FauxPrismaError("P2028");
    await expect(serializableTransaction(async () => "ok")).rejects.toMatchObject({ code: "P2028" });
    expect(h.appels).toBe(1);
  });
});

describe("SOUPÇON — les bornes de temps de la transaction ne sont pas posées", () => {
  // Le `PATCH` enchaîne jusqu'à huit allers-retours DANS la transaction. Les défauts Prisma
  // (5 s de `timeout`, 2 s de `maxWait`) ne sont pas relevés, et `interclub-gate.ts` décrit le
  // cold start Neon comme « visible à l'œil nu ». La première écriture d'une soirée pourrait
  // donc dépasser la borne par défaut.
  //
  // Ce test ne dit pas que c'est trop court : il RÉVÈLE que la question n'a jamais été posée.
  // Le jour où l'on décide d'une valeur, il échoue et force à l'écrire ici.
  it("ne passe aujourd'hui que le niveau d'isolation, sans timeout ni maxWait", async () => {
    await serializableTransaction(async () => "ok");
    expect(h.dernieresOptions).toEqual({ isolationLevel: "Serializable" });
    expect(h.dernieresOptions).not.toHaveProperty("timeout");
    expect(h.dernieresOptions).not.toHaveProperty("maxWait");
  });
});
