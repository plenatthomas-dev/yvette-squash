import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// Le rate-limit du login a DEUX dimensions. Par IP seule, un attaquant qui vise UN membre
// depuis plusieurs IP (botnet, 4G) n'est jamais freiné. Et l'IP doit venir de la source sûre :
// avec la variante naïve (1re valeur de x-forwarded-for), le compteur restait à zéro.

const h = vi.hoisted(() => ({
  ipCount: 0,
  accountCount: 0,
  count: vi.fn(),
  // Typés + renvoient des promesses : la route chaîne un `.catch()` sur create, et les tests
  // inspectent les arguments reçus.
  create: vi.fn(async (_args: { data: { ip: string; identifier: string } }) => ({})),
  deleteMany: vi.fn(async (_args: { where: Record<string, unknown> }) => ({ count: 0 })),
  login: vi.fn(),
  createSession: vi.fn(async (_resa: unknown) => "sid"),
  // Réglage `block` lu par la garde « appli fermée ». `null` = appli ouverte (défaut).
  appSetting: vi.fn(async () => null as { value: string } | null),
  LoginRefusedError: class extends Error {
    constructor(readonly reason: string) {
      super(reason);
    }
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    loginAttempt: { count: h.count, create: h.create, deleteMany: h.deleteMany },
    appSetting: { findUnique: h.appSetting },
    user: {
      findUnique: async ({ where }: { where: { email: string } }) => ({ id: "u-" + where.email, email: where.email }),
    },
  },
}));
// Les erreurs typées et leurs gardes sont les VRAIES : la route décide sur leur classement
// (refus → 401 compté, indisponible → 503 non compté).
vi.mock("@/lib/resamania/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/resamania/client")>()),
  login: h.login,
}));
vi.mock("@/lib/session", () => ({
  createSession: h.createSession,
  normalizeEmail: (s: string) => s.trim().toLowerCase(),
  AccountDisabledError: class extends Error {},
  LoginRefusedError: h.LoginRefusedError,
}));

import { POST } from "./route";
import { ResaAuthRejectedError, ResaUnavailableError } from "@/lib/resamania/client";

const req = (body: unknown, headers: Record<string, string> = {}) =>
  ({
    json: async () => body,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  }) as unknown as NextRequest;

const creds = { username: "Alice@Example.COM", password: "pw" };

beforeEach(() => {
  vi.clearAllMocks();
  h.ipCount = 0;
  h.accountCount = 0;
  // count() est appelé 2× : d'abord par IP, puis par identifiant.
  h.count.mockImplementation(async (args: { where: { ip?: string } }) =>
    args.where.ip !== undefined ? h.ipCount : h.accountCount,
  );
  h.login.mockResolvedValue({ identity: { givenName: "Alice", familyName: "Martin" } });
  h.createSession.mockResolvedValue("sid");
  h.appSetting.mockResolvedValue(null); // appli ouverte par défaut
  process.env.ADMIN_EMAILS = "chef@example.com";
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/auth/login — rate limiting", () => {
  it("laisse passer une tentative normale", async () => {
    const res = await POST(req(creds, { "x-real-ip": "1.2.3.4" }));
    expect(res.status).toBe(200);
  });

  it("bloque au-delà de la limite par IP", async () => {
    h.ipCount = 5;
    const res = await POST(req(creds, { "x-real-ip": "1.2.3.4" }));
    expect(res.status).toBe(429);
    expect(h.login).not.toHaveBeenCalled(); // rien n'est transmis à ResaMania
  });

  it("bloque au-delà de la limite par COMPTE, même depuis une IP neuve", async () => {
    h.ipCount = 0; // IP jamais vue : la limite par IP ne dit rien
    h.accountCount = 10;
    const res = await POST(req(creds, { "x-real-ip": "203.0.113.99" }));
    expect(res.status).toBe(429);
    expect(h.login).not.toHaveBeenCalled();
  });

  it("compte l'identifiant NORMALISÉ (casse et espaces ignorés)", async () => {
    await POST(req({ username: "  ALICE@example.com ", password: "pw" }, { "x-real-ip": "1.2.3.4" }));
    const accountQuery = h.count.mock.calls.find((c) => c[0].where.identifier !== undefined);
    expect(accountQuery?.[0].where.identifier).toBe("alice@example.com");
  });

  it("l'IP vient de la source SÛRE, pas de la valeur forgée par le client", async () => {
    await POST(req(creds, { "x-forwarded-for": "6.6.6.6, 203.0.113.7" }));
    const ipQuery = h.count.mock.calls.find((c) => c[0].where.ip !== undefined);
    expect(ipQuery?.[0].where.ip).toBe("203.0.113.7");
    expect(ipQuery?.[0].where.ip).not.toBe("6.6.6.6");
  });

  it("un échec incrémente les DEUX compteurs", async () => {
    // Rejet construit à l'appel (et non `mockRejectedValue`) : vitest remonte comme échec du
    // test une exception levée par un espion, même attrapée par la route.
    h.login.mockImplementation(() => Promise.reject(new ResaAuthRejectedError("bad creds")));
    const res = await POST(req(creds, { "x-real-ip": "1.2.3.4" }));
    expect(res.status).toBe(401);
    expect(h.create.mock.calls[0][0].data).toEqual({
      ip: "1.2.3.4",
      identifier: "alice@example.com",
    });
  });

  it("une réussite n'efface QUE les échecs du couple (IP, compte)", async () => {
    // Ce test figeait l'inverse : `OR: [{ ip }, { identifier }]`, qui effaçait les échecs de
    // l'IP sur TOUS les comptes. Avec UN compte valide, un attaquant alternait quatre essais
    // sur les comptes visés et une connexion réussie avec le sien : la limite par IP repartait
    // de zéro à chaque fois, donc ne limitait plus rien.
    await POST(req(creds, { "x-real-ip": "1.2.3.4" }));
    const cleared = h.deleteMany.mock.calls.at(-1)?.[0].where;
    expect(cleared).toEqual({ ip: "1.2.3.4", identifier: "alice@example.com" });
  });

  it("ResaMania indisponible → 503, SANS compter de tentative", async () => {
    // Une panne amont n'est pas la faute du membre ; la compter verrouillerait tout un club
    // derrière son IP partagée au bout de cinq essais.
    h.login.mockImplementation(() => Promise.reject(new ResaUnavailableError("down", 503)));
    const res = await POST(req(creds, { "x-real-ip": "1.2.3.4" }));
    expect(res.status).toBe(503);
    expect(h.create).not.toHaveBeenCalled();
    expect(await res.json()).not.toHaveProperty("maintenance"); // pas une panne de NOTRE base
  });

  it("erreur à l'ouverture de session (ex. email déjà pris, P2002) → 500, PAS « identifiants invalides »", async () => {
    h.createSession.mockImplementation(() =>
      Promise.reject(Object.assign(new Error("Unique constraint failed on the fields: (`email`)"), { code: "P2002" })),
    );
    const res = await POST(req(creds, { "x-real-ip": "1.2.3.4" }));
    expect(res.status).toBe(500);
    expect(h.create).not.toHaveBeenCalled(); // le mot de passe était bon : rien à compter
  });

  it.each(["foreign_club", "blocked", "identity_conflict"])(
    "connexion refusée par l'appli (%s) → 403, jamais comptée comme échec",
    async (reason) => {
      h.createSession.mockImplementation(() => Promise.reject(new h.LoginRefusedError(reason)));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await POST(req(creds, { "x-real-ip": "1.2.3.4" }));
      expect(res.status).toBe(403);
      expect(h.create).not.toHaveBeenCalled();
    },
  );

  it("borne la longueur des entrées (400) sans rien lire ni appeler", async () => {
    const long = await POST(req({ username: "a".repeat(255), password: "pw" }));
    expect(long.status).toBe(400);
    const longPw = await POST(req({ username: "alice@example.com", password: "p".repeat(201) }));
    expect(longPw.status).toBe(400);
    expect(h.count).not.toHaveBeenCalled();
    expect(h.login).not.toHaveBeenCalled();
  });

  it("refuse un identifiant non textuel sans rien compter", async () => {
    const res = await POST(req({ username: { $ne: null }, password: "pw" }));
    expect(res.status).toBe(400);
    expect(h.count).not.toHaveBeenCalled();
  });
});

// Blocage de l'appli piloté depuis /admin : les membres ne se connectent plus, les admins si.
describe("POST /api/auth/login — appli bloquée", () => {
  const blocked = { value: JSON.stringify({ enabled: true, message: "Appli en maintenance" }) };

  it("refuse un membre avec le message de l'admin, sans appeler ResaMania", async () => {
    h.appSetting.mockResolvedValue(blocked);
    const res = await POST(req(creds, { "x-real-ip": "1.2.3.4" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "Appli en maintenance", blocked: true });
    expect(h.login).not.toHaveBeenCalled();
  });

  it("laisse passer un ADMIN (c'est tout l'intérêt : intervenir appli fermée)", async () => {
    h.appSetting.mockResolvedValue(blocked);
    const res = await POST(
      req({ username: "chef@example.com", password: "pw" }, { "x-real-ip": "1.2.3.4" }),
    );
    expect(res.status).toBe(200);
    expect(h.login).toHaveBeenCalled();
  });

  it("ne renvoie PAS le drapeau `maintenance` (ne doit pas passer pour une panne de base)", async () => {
    h.appSetting.mockResolvedValue(blocked);
    const res = await POST(req(creds, { "x-real-ip": "1.2.3.4" }));
    // `maintenance: true` déclencherait la bannière automatique côté client (cf. lib/apiFetch),
    // qui annonce une base injoignable — ici c'est une fermeture VOLONTAIRE, message différent.
    expect(await res.json()).not.toHaveProperty("maintenance");
  });

  it("laisse l'appli OUVERTE si la lecture du réglage échoue (fail-open)", async () => {
    // Se tromper en fermant le club entier serait bien plus grave que de laisser passer
    // quelqu'un pendant une panne de réglage.
    h.appSetting.mockRejectedValue(new Error("base injoignable"));
    const res = await POST(req(creds, { "x-real-ip": "1.2.3.4" }));
    expect(res.status).toBe(200);
  });
});
