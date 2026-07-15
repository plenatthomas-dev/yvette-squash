import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { NextRequest } from "next/server";
import { cronAuthorized } from "./cron-auth";

const SECRET = "65088acdda629475005b4780c201450d260205da6a49ea4a";

const req = (opts: { auth?: string; token?: string }) =>
  ({
    headers: { get: (k: string) => (k.toLowerCase() === "authorization" ? (opts.auth ?? null) : null) },
    url: `https://x/api/cron/check-alerts${opts.token !== undefined ? `?token=${encodeURIComponent(opts.token)}` : ""}`,
  }) as unknown as NextRequest;

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("NODE_ENV", "production");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("cronAuthorized", () => {
  it("accepte le bon secret en en-tête Bearer", () => {
    expect(cronAuthorized(req({ auth: `Bearer ${SECRET}` }))).toBe(true);
  });

  it("accepte le bon secret en query string (crons externes sans en-tête)", () => {
    expect(cronAuthorized(req({ token: SECRET }))).toBe(true);
  });

  it("refuse un mauvais secret", () => {
    expect(cronAuthorized(req({ auth: `Bearer ${SECRET.slice(0, -1)}0` }))).toBe(false);
    expect(cronAuthorized(req({ token: "mauvais" }))).toBe(false);
  });

  it("refuse une requête sans aucune preuve", () => {
    expect(cronAuthorized(req({}))).toBe(false);
  });

  it("refuse un préfixe du secret (pas de comparaison partielle)", () => {
    expect(cronAuthorized(req({ token: SECRET.slice(0, 10) }))).toBe(false);
  });

  it("ne jette pas sur des longueurs différentes (timingSafeEqual l'exigerait)", () => {
    // Le piège de crypto.timingSafeEqual : il LÈVE si les buffers n'ont pas la même taille.
    // Un secret plus court ou plus long doit rendre false, pas planter la route.
    expect(() => cronAuthorized(req({ token: "x" }))).not.toThrow();
    expect(() => cronAuthorized(req({ auth: "Bearer " + "x".repeat(500) }))).not.toThrow();
    expect(cronAuthorized(req({ token: "x" }))).toBe(false);
  });

  it("échoue FERMÉ en production si CRON_SECRET est absent", () => {
    vi.stubEnv("CRON_SECRET", "");
    expect(cronAuthorized(req({ token: "peu importe" }))).toBe(false);
  });

  it("reste ouvert hors production sans secret (déclenchement manuel en dev)", () => {
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(cronAuthorized(req({}))).toBe(true);
  });
});
