import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import type { ResaSession } from "./types";

// L'ADAPTATEUR RESAMANIA DOIT DIRE POURQUOI IL ÉCHOUE.
//
// Trois issues à ne JAMAIS confondre, parce que les appelants en tirent des actes opposés :
//  - « ResaMania dit non » (identifiants, refresh token révoqué) → supprimer la session,
//    compter la tentative de connexion ;
//  - « ResaMania ne répond pas » (5xx, 429, réseau, délai) → ne rien détruire, réessayer ;
//  - « on ne sait pas si l'écriture a eu lieu » (réservation/annulation sans réponse) → ni
//    succès ni échec : inviter à vérifier le planning.
// Avant, tout était un `Error` anonyme, et un 503 passager au rafraîchissement supprimait la
// session du membre. Aucun appel réseau réel : `fetch` est remplacé.

const fetchMock = vi.fn();

// Le module lit ses variables d'environnement au chargement : on les pose AVANT de l'importer.
let client: typeof import("./client");
beforeAll(async () => {
  vi.stubEnv("RESA_CLIENT_ID", "cid");
  vi.stubEnv("RESA_CLIENT_SECRET", "secret");
  vi.stubEnv("RESA_USE_MOCK", "0");
  vi.stubGlobal("fetch", fetchMock);
  client = await import("./client");
});
afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

// Panne réseau / délai dépassé : `fetch` REJETTE. Simulé par une fonction simple plutôt que par
// `fetchMock` : vitest remonte comme échec du test l'exception levée par un espion `vi.fn`,
// même quand le code testé l'attrape — ce qui est justement le comportement vérifié ici.
const failFetch = (err: unknown) =>
  vi.stubGlobal("fetch", async () => {
    throw err;
  });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const identity = {
  contactUserId: "1",
  contactId: "/t/contacts/9",
  contactNumber: "C9",
  clubId: "/t/clubs/1",
  familyName: "Martin",
  givenName: "Alice",
  email: "alice@example.fr",
  contactCreatedAt: "2020-01-01",
};
const expired = (): ResaSession => ({
  accessToken: "old",
  refreshToken: "refresh-old",
  expiresAt: Date.now() - 1000,
  identity,
});

describe("ensureFresh — classement des échecs du rafraîchissement", () => {
  it("503 → indisponible (passager), surtout pas un refus", async () => {
    fetchMock.mockResolvedValue(json({ error: "oops" }, 503));
    const err = await client.ensureFresh(expired()).catch((e) => e);
    expect(client.isResaUnavailable(err)).toBe(true);
    expect(client.isResaAuthRejected(err)).toBe(false);
  });

  it("429 → indisponible", async () => {
    fetchMock.mockResolvedValue(json({}, 429));
    expect(client.isResaUnavailable(await client.ensureFresh(expired()).catch((e) => e))).toBe(true);
  });

  it("400 invalid_grant → refus d'authentification (jeton révoqué : reconnexion requise)", async () => {
    fetchMock.mockResolvedValue(json({ error: "invalid_grant" }, 400));
    const err = await client.ensureFresh(expired()).catch((e) => e);
    expect(client.isResaAuthRejected(err)).toBe(true);
    expect(err).toBeInstanceOf(client.ResaAuthRejectedError);
  });

  it("401 invalid_client → PAS un refus : c'est notre configuration, pas le jeton du membre", async () => {
    // En refus, chaque rafraîchissement supprimerait une session : une variable d'environnement
    // fausse viderait la base de toutes ses sessions au fil des heures.
    fetchMock.mockResolvedValue(json({ error: "invalid_client" }, 401));
    const err = await client.ensureFresh(expired()).catch((e) => e);
    expect(client.isResaAuthRejected(err)).toBe(false);
    expect(client.isResaUnavailable(err)).toBe(true);
  });

  it("erreur réseau ou délai dépassé → indisponible", async () => {
    failFetch(new DOMException("The operation timed out.", "TimeoutError"));
    expect(client.isResaUnavailable(await client.ensureFresh(expired()).catch((e) => e))).toBe(true);
    failFetch(new TypeError("fetch failed"));
    expect(client.isResaUnavailable(await client.ensureFresh(expired()).catch((e) => e))).toBe(true);
  });

  it("réussite : UN seul appel (pas de /contact_users), identité conservée", async () => {
    // L'appel /contact_users du rafraîchissement était jeté par session.ts ; il ne faisait
    // qu'ajouter une occasion d'échouer après la rotation du refresh token.
    fetchMock.mockResolvedValue(
      json({ access_token: "a.b.c", refresh_token: "refresh-new", expires_in: 3600 }),
    );
    const fresh = await client.ensureFresh(expired());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/oauth/v2/token");
    expect(fresh).toMatchObject({ accessToken: "a.b.c", refreshToken: "refresh-new", identity });
  });

  it("jeton encore valide → aucun appel", async () => {
    const s = { ...expired(), expiresAt: Date.now() + 60_000 };
    expect(await client.ensureFresh(s)).toBe(s);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("timeouts — aucun appel ResaMania sans délai", () => {
  it("chaque fetch porte un signal (login, token, planning, book, cancel, findAttendeeId)", async () => {
    fetchMock.mockImplementation(async () => json({ "hydra:member": [] }, 200));
    await client.login({ username: "a", password: "b" }).catch(() => {});
    await client.ensureFresh(expired()).catch(() => {});
    await client.findAttendeeId(expired(), "/t/class_events/1").catch(() => {});
    await client.book(expired(), "/t/class_events/1").catch(() => {});
    await client.cancel(expired(), "/t/attendees/1").catch(() => {});
    await client.getPlanning("2026-10-17", "tok", new Map(), true).catch(() => {});
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(6);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
    }
  });
});

describe("book / cancel — écriture sans réponse = résultat INCONNU", () => {
  it("book : délai dépassé → ResaOutcomeUnknownError (ni succès, ni refus)", async () => {
    failFetch(new DOMException("The operation timed out.", "TimeoutError"));
    const err = await client.book(expired(), "/t/class_events/1").catch((e) => e);
    expect(client.isResaOutcomeUnknown(err)).toBe(true);
    // Distincte de « indisponible » : un appelant qui réessaie sur indisponible ne doit pas
    // relancer une réservation peut-être déjà prise.
    expect(client.isResaUnavailable(err)).toBe(false);
  });

  it("cancel : connexion coupée → ResaOutcomeUnknownError", async () => {
    failFetch(new TypeError("fetch failed"));
    const err = await client.cancel(expired(), "/t/attendees/1").catch((e) => e);
    expect(client.isResaOutcomeUnknown(err)).toBe(true);
  });

  it("book : refus reçu → { ok: false } comme avant (pas d'exception)", async () => {
    fetchMock.mockResolvedValue(json({ "hydra:description": "has-overlapping-slots" }, 400));
    expect(await client.book(expired(), "/t/class_events/1")).toEqual({
      ok: false,
      error: "has-overlapping-slots",
    });
  });

  it("book : 201 au corps illisible → succès sans attendeeId (la résa EST prise)", async () => {
    fetchMock.mockResolvedValue(new Response("pas du json", { status: 201 }));
    expect(await client.book(expired(), "/t/class_events/1")).toEqual({ ok: true });
  });
});

describe("findAttendeeId — « introuvable » et « indisponible » ne se confondent plus", () => {
  it("ResaMania en 503 → ResaUnavailableError, et non null (« aucune résa »)", async () => {
    fetchMock.mockResolvedValue(json({}, 503));
    const err = await client.findAttendeeId(expired(), "/t/class_events/1").catch((e) => e);
    expect(client.isResaUnavailable(err)).toBe(true);
  });

  it("délai dépassé → ResaUnavailableError (lecture : pas de « résultat inconnu »)", async () => {
    failFetch(new DOMException("The operation timed out.", "TimeoutError"));
    const err = await client.findAttendeeId(expired(), "/t/class_events/1").catch((e) => e);
    expect(client.isResaUnavailable(err)).toBe(true);
  });

  it("404 reçu → null, comme avant (la ressource n'existe vraiment pas)", async () => {
    fetchMock.mockResolvedValue(json({}, 404));
    expect(await client.findAttendeeId(expired(), "/t/class_events/1")).toBeNull();
  });
});

describe("login — refus et panne ne se ressemblent plus", () => {
  it("formulaire renvoyé sans code d'autorisation → refus d'authentification", async () => {
    // Mauvais mot de passe : ResaMania répond normalement mais ne délivre aucun code.
    fetchMock.mockImplementation(async () => new Response("<form>", { status: 200 }));
    const err = await client.login({ username: "a", password: "faux" }).catch((e) => e);
    expect(client.isResaAuthRejected(err)).toBe(true);
  });

  it("ResaMania en 503 pendant le flux → indisponible (ne doit pas être compté comme échec)", async () => {
    fetchMock.mockImplementation(async () => new Response("down", { status: 503 }));
    const err = await client.login({ username: "a", password: "b" }).catch((e) => e);
    expect(client.isResaUnavailable(err)).toBe(true);
    expect(client.isResaAuthRejected(err)).toBe(false);
  });
});

describe("getPlanningWithMeta — l'appelant sait si la photo est fraîche", () => {
  const events = { "hydra:member": [] };

  it("lecture amont → fromCache false et fetchedAt pris AVANT l'appel ; relecture → cache", async () => {
    fetchMock.mockResolvedValue(json(events));
    const avant = Date.now();
    const first = await client.getPlanningWithMeta("2026-12-01", "tok", new Map(), true);
    expect(first.fromCache).toBe(false);
    expect(first.fetchedAt).toBeGreaterThanOrEqual(avant);
    expect(first.fetchedAt).toBeLessThanOrEqual(Date.now());

    fetchMock.mockClear();
    const second = await client.getPlanningWithMeta("2026-12-01", "tok", new Map());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(second.fromCache).toBe(true);
    // L'âge de la photo servie est celui de la lecture d'origine, pas celui du service.
    expect(second.fetchedAt).toBe(first.fetchedAt);
  });

  it("planning en 503 → indisponible", async () => {
    fetchMock.mockResolvedValue(json({}, 503));
    const err = await client.getPlanningWithMeta("2026-12-02", "tok", new Map(), true).catch((e) => e);
    expect(client.isResaUnavailable(err)).toBe(true);
  });
});
