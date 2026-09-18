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

  it("abandonne en 409 après six tentatives, avec le message fourni", async () => {
    h.conflitsRestants = 99;
    await expect(serializableTransaction(async () => "ok", "Prise concurrente")).rejects.toMatchObject(
      { status: 409, message: "Prise concurrente" },
    );
    expect(h.appels).toBe(6);
  });

  // LE CAS QUI A MOTIVÉ LE PASSAGE DE QUATRE À SIX. Cinq croisements d'affilée, c'est ce que
  // produit un tricount à six payeurs qui valident ensemble : sous l'ancien plafond la
  // cinquième tentative n'existait pas, et le membre lisait « Validation concurrente ».
  it("tient cinq croisements d'affilée — ce qu'un tricount à six payeurs produit vraiment", async () => {
    h.conflitsRestants = 5;
    await expect(serializableTransaction(async () => "ok")).resolves.toBe("ok");
    expect(h.appels).toBe(6);
  });

  it("laisse passer du temps entre deux tentatives, sinon le compte d'essais ne veut rien dire", async () => {
    // Le plafond de six tentatives se justifie par « au-delà, c'est une contention durable ».
    // Le raisonnement suppose que du temps passe : sans recul, les essais s'épuisaient en
    // quelques millisecondes et rendaient un 409 qu'une pause de rien du tout aurait évité.
    //
    // La borne mesurée est le PLANCHER, pas « plus de zéro » : c'est lui qui garantit qu'un
    // rejeu ne repart pas dans la milliseconde du gagnant encore en vol. Trois reculs, donc au
    // moins 3 × 5 ms.
    h.conflitsRestants = 3;
    const t0 = Date.now();
    await serializableTransaction(async () => "ok");
    expect(h.appels).toBe(4);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
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
  it("ne dépasse jamais 5 + 10 × 2^(n-1) ms, soit 335 ms cumulées avant la dernière", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    expect(backoffFor(1)).toBeLessThanOrEqual(15);
    expect(backoffFor(2)).toBeLessThanOrEqual(25);
    expect(backoffFor(3)).toBeLessThanOrEqual(45);
    expect(backoffFor(4)).toBeLessThanOrEqual(85);
    expect(backoffFor(5)).toBeLessThanOrEqual(165);
    // Cumul au pire avant la sixième et dernière tentative.
    const cumul = [1, 2, 3, 4, 5].reduce((t, n) => t + backoffFor(n), 0);
    expect(cumul).toBeLessThanOrEqual(335);
    vi.restoreAllMocks();
  });

  it("croît avec le numéro de tentative", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(backoffFor(3)).toBeGreaterThan(backoffFor(1));
    vi.restoreAllMocks();
  });

  it("est TIRÉ AU SORT : deux écrivains en conflit ne doivent pas rejouer en cadence", () => {
    // Sans tirage, deux transactions concurrentes se retrouvent au même instant à chaque tour.
    // Le tirage porte sur la LARGEUR ; le plancher, lui, ne bouge pas (cas suivant).
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(backoffFor(3)).toBe(5);
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(backoffFor(3)).toBe(45);
    vi.restoreAllMocks();
  });

  // LE DÉFAUT QUE CE PLANCHER FERME. Le tirage pouvait rendre 0 : le rejeu repartait dans la
  // même milliseconde, pendant que la transaction gagnante était encore en vol — une tentative
  // consommée sans avoir jamais eu sa chance. Aucun tirage, si malchanceux soit-il, ne doit
  // plus rendre un recul nul.
  it("ne rend JAMAIS zéro, même au tirage le plus malchanceux", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    for (const n of [1, 2, 3, 4, 5]) expect(backoffFor(n)).toBeGreaterThanOrEqual(5);
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

  it("⚠️ rend {} sur un TABLEAU, que `typeof` fait pourtant passer pour un objet", async () => {
    // `[1,2,3]` ressortait tel quel, typé `Record<string, unknown>`. La promesse de cette
    // fonction — « remettre ces corps sur le chemin ordinaire » — n'était alors tenue que par
    // ACCIDENT : les routes valident champ par champ, et `tableau.date` vaut `undefined`, donc
    // ça finissait bien en 400. Rien ne garantit que la prochaine route lira un champ plutôt
    // qu'une longueur ou un index.
    expect(await readJsonBody(req(async () => [1, 2, 3]))).toEqual({});
    expect(await readJsonBody(req(async () => []))).toEqual({});
  });

  it("rend {} sur un corps illisible, comme avant", async () => {
    expect(await readJsonBody(req(async () => { throw new SyntaxError("Unexpected token"); }))).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LES DEUX SOUPÇONS, ET CE QU'ILS SONT DEVENUS.
//
// Ces tests-ci décrivent la MÉCANIQUE : quels codes la boucle rejoue, et quelles options elle
// passe. Ils ne pouvaient pas dire ce que Postgres répond vraiment — un faux client rend le
// code qu'on lui souffle. C'est `http-tx.pg.test.ts` qui a tranché, sur un vrai serveur, avec
// deux transactions concurrentes ; les réponses sont recopiées ci-dessous, à leur place.
// ─────────────────────────────────────────────────────────────────────────────

describe("quels échecs sont rejoués, et lesquels ne le sont pas", () => {
  // ✅ TRANCHÉ (Postgres 16, `http-tx.pg.test.ts` cas A et A2). La crainte était que le motif
  // « supprimer puis réinsérer les jeux » sorte en violation d'unicité (23505 → P2002), qui
  // n'est pas rejouée, plutôt qu'en échec de sérialisation (40001 → P2034), qui l'est.
  //
  // Mesuré : le second marqueur sort en **P2034**, table vide comme table déjà peuplée. Sous
  // Serializable, Postgres détecte le conflit avant d'en arriver à l'index unique. Passée par
  // `serializableTransaction`, la course aboutit des DEUX côtés, au second tour (cas A').
  // Ne rejouer que P2034 est donc le bon réglage, et non un oubli.
  it("rejoue P2034 — le conflit de sérialisation", async () => {
    h.conflitsRestants = 2;
    await expect(serializableTransaction(async () => "ok")).resolves.toBe("ok");
    expect(h.appels).toBe(3);
  });

  it("ne rejoue PAS P2002 — la violation d'unicité", async () => {
    // Et c'est sans conséquence connue : le motif qu'on soupçonnait de la produire n'en produit
    // pas (cf. ci-dessus). Le test reste, parce qu'il dit où passe la frontière.
    h.jette = new FauxPrismaError("P2002");
    await expect(serializableTransaction(async () => "ok")).rejects.toMatchObject({ code: "P2002" });
    expect(h.appels).toBe(1);
  });

  it("ne rejoue PAS P2028 — la transaction qui n'a pas tenu dans ses bornes", async () => {
    // ⚠️ Celui-ci, en revanche, EST atteignable — cf. le bloc suivant. Il sort en 500.
    // Et il n'est pas rejouable en l'état : P2028 recouvre DEUX échecs indiscernables par le
    // code (« pas pu commencer dans `maxWait` » et « expirée après `timeout` »). Rejouer le
    // premier serait juste ; rejouer le second rejouerait un travail qui a déjà tourné jusqu'au
    // bout, six fois.
    h.jette = new FauxPrismaError("P2028");
    await expect(serializableTransaction(async () => "ok")).rejects.toMatchObject({ code: "P2028" });
    expect(h.appels).toBe(1);
  });
});

describe("les bornes de temps de la transaction", () => {
  // ✅ MESURÉ (`http-tx.pg.test.ts`, cas B1 à B4), puis TRANCHÉ. Les deux défauts de Prisma
  // existent bien, et les voici chiffrés sur un vrai serveur :
  //
  //   * `maxWait` 2 s — mesuré à 2005 ms. Il court AVANT le premier ordre SQL, sur l'obtention
  //     de la connexion : c'est là que tombe un réveil de base froide, donc la PREMIÈRE écriture
  //     d'une soirée. Dépassé ⇒ P2028 ⇒ 500 pour le marqueur. **Relevé à 10 s**, et le cas B4
  //     vérifie qu'une transaction qui attendait plus de 2 s aboutit désormais ;
  //   * `timeout` 5 s — laissé au défaut, délibérément : mesuré, ce plafond n'INTERROMPT pas la
  //     requête (elle est allée au bout de ses 6 s, c'est au retour qu'elle a été refusée). Le
  //     relever ne ferait gagner de temps à personne, seulement déplacer le moment où l'on jette
  //     un travail abouti.
  //
  // La valeur est ÉCRITE ici pour qu'on ne puisse pas la changer par distraction : c'est un
  // chiffre qui décide de ce que voit un marqueur un jeudi soir, pas un détail de réglage.
  it("accorde dix secondes pour OBTENIR une connexion, et laisse `timeout` au défaut", async () => {
    await serializableTransaction(async () => "ok");
    expect(h.dernieresOptions).toEqual({ isolationLevel: "Serializable", maxWait: 10_000 });
    expect(h.dernieresOptions).not.toHaveProperty("timeout");
  });
});
