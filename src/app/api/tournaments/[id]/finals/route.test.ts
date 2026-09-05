import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";

// Cette route a trois façons d'échouer, et elles ne se ressemblent pas :
//
//   * un CONFLIT de sérialisation épuisé → 409, « réessaie » — la faute n'est à personne ;
//   * une erreur MÉTIER de `materializeFinals` → 409, avec son message français tel quel ;
//   * une erreur de BASE inattendue → 500, message générique, détail dans les journaux seuls.
//
// Les deux dernières partagent le même `catch` et se distinguent par un `instanceof`. Se
// tromper de branche, c'est soit renvoyer 409 sur une panne (le créateur reclique indéfiniment
// sur un bouton qui ne marchera jamais), soit recracher au client le message brut de Postgres —
// noms de colonnes, contraintes, parfois valeurs. Rien de tout cela n'était vérifié.

const h = vi.hoisted(() => ({
  featureOn: true,
  session: null as null | { userId: string },
  tournament: null as null | { createdById: string; format: string },
  txOptions: undefined as unknown,
  appels: 0,
  materializeFinals: vi.fn(async () => 4),
}));

vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({
    tricount: false,
    emailLogin: false,
    directory: false,
    delegation: false,
    tournament: h.featureOn,
    ranking: false,
  }),
}));
vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    tournament: { findUnique: async () => h.tournament },
    $transaction: (fn: (tx: unknown) => unknown, options?: unknown) => {
      h.txOptions = options;
      h.appels++;
      return Promise.resolve(fn({}));
    },
  },
}));
vi.mock("@/lib/tournament-db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tournament-db")>("@/lib/tournament-db");
  return { ...actual, materializeFinals: h.materializeFinals };
});

import { POST } from "./route";

const req = () => ({ cookies: { get: () => undefined } }) as unknown as NextRequest;
const params = { params: Promise.resolve({ id: "t1" }) };

const erreurDb = (code: string, message: string) =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: "6.0.0" });

beforeEach(() => {
  h.featureOn = true;
  h.session = { userId: "u1" };
  h.tournament = { createdById: "u1", format: "pools_bracket" };
  h.txOptions = undefined;
  h.appels = 0;
  h.materializeFinals.mockReset().mockResolvedValue(4);
});

describe("POST /api/tournaments/[id]/finals — qui a le droit", () => {
  it("404 si la fonction est désactivée", async () => {
    h.featureOn = false;
    expect((await POST(req(), params)).status).toBe(404);
    expect(h.appels).toBe(0);
  });

  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await POST(req(), params)).status).toBe(401);
    expect(h.appels).toBe(0);
  });

  it("404 si le tournoi n'existe pas", async () => {
    h.tournament = null;
    const res = await POST(req(), params);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Tournoi introuvable" });
    expect(h.appels).toBe(0);
  });

  it("403 pour un participant qui n'est pas le créateur", async () => {
    h.session = { userId: "u2" };
    const res = await POST(req(), params);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: "Seul le créateur peut générer la phase finale",
    });
    expect(h.appels).toBe(0);
  });

  it.each([["pools"], ["bracket"]])("400 sur un tournoi en « %s »", async (format) => {
    // Un tournoi de poules seules n'a pas de phase finale : générer un tableau y créerait des
    // matchs qu'aucun écran ne sait afficher.
    h.tournament = { createdById: "u1", format };
    const res = await POST(req(), params);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Ce tournoi n'a pas de phase finale" });
    expect(h.appels).toBe(0);
  });

  it("200 avec le nombre de tableaux créés", async () => {
    h.materializeFinals.mockResolvedValue(3);
    const res = await POST(req(), params);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, tiers: 3 });
  });

  it("génère en isolation Serializable, pas dans une transaction ordinaire", async () => {
    // La garde « déjà générée » de `materializeFinals` est un lire-puis-écrire : sans
    // Serializable, deux clics simultanés la passent tous les deux (mesuré sur vraie base).
    await POST(req(), params);
    expect(h.txOptions).toMatchObject({ isolationLevel: "Serializable" });
  });
});

describe("POST /api/tournaments/[id]/finals — les trois façons d'échouer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejoue un conflit de sérialisation, et rend 200 s'il passe au second essai", async () => {
    h.materializeFinals
      .mockRejectedValueOnce(erreurDb("P2034", "could not serialize access"))
      .mockResolvedValue(4);
    const res = await POST(req(), params);
    expect(res.status).toBe(200);
    expect(h.appels).toBe(2);
  });

  it("409 « réessaie » après quatre tentatives infructueuses", async () => {
    // Quatre, pas plus : au-delà, ce n'est plus un conflit ponctuel mais de la contention, et
    // insister ferait attendre le créateur sans améliorer ses chances.
    //
    // ⚠️ Ce cas ne distingue PAS les deux branches du `catch` : la traduction de l'`HttpError`
    // par `httpErrorResponse` et le repli final produisent ici exactement la même réponse
    // (409, même message). Retirer la première ligne du `catch` ne fait donc rougir aucun
    // test — et aucun test ne le pourrait, faute de différence observable. C'est une ceinture
    // par-dessus des bretelles, utile le jour où le repli changera de statut ; on l'écrit ici
    // pour que le prochain lecteur ne la croie pas couverte.
    h.materializeFinals.mockRejectedValue(erreurDb("P2034", "could not serialize access"));
    const res = await POST(req(), params);
    expect(res.status).toBe(409);
    // Le `code` accompagne désormais tout 409 de contention : c'est sur lui, jamais sur le
    // texte, qu'un client branche — et cette route en rend un seul, là où les disponibilités
    // en rendent deux qu'il fallait pouvoir distinguer.
    await expect(res.json()).resolves.toEqual({
      error: "Génération concurrente, réessaie",
      code: "write_conflict",
    });
    expect(h.appels).toBe(4);
  });

  it.each([
    ["Toutes les poules ne sont pas terminées"],
    ["Phase finale déjà générée"],
  ])("409 en relayant le refus métier : « %s »", async (message) => {
    // Ces messages sont des littéraux français écrits dans `materializeFinals` : ils sont
    // faits pour être lus par le créateur, et c'est pour cela qu'on les relaie tels quels.
    h.materializeFinals.mockRejectedValue(new Error(message));
    const res = await POST(req(), params);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: message });
  });

  it("500 générique sur une erreur de BASE — le message de Postgres ne sort pas", async () => {
    // C'est la moitié qui compte : le message brut d'une erreur Prisma cite la contrainte, la
    // table, parfois la valeur en conflit. Le relayer en 409 le mettrait sous les yeux du
    // premier venu, et lui ferait recliquer sur un bouton en panne.
    const journal = vi.spyOn(console, "error").mockImplementation(() => {});
    h.materializeFinals.mockRejectedValue(
      erreurDb("P2002", 'Unique constraint failed on the fields: (`tournamentId`,`tier`)'),
    );
    const res = await POST(req(), params);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Génération impossible pour le moment" });
    expect(JSON.stringify(body)).not.toContain("tournamentId");
    // Le détail n'est pas perdu pour autant : il part dans les journaux du serveur.
    expect(journal).toHaveBeenCalled();
    // Et ce n'est pas rejoué : une contrainte violée le sera encore au quatrième essai.
    expect(h.appels).toBe(1);
  });
});
