import { describe, it, expect } from "vitest";
import { assertProductionEnv, envProblems } from "./env-check.mjs";

const OK = {
  VERCEL_ENV: "production",
  DATABASE_URL: "postgres://x",
  DIRECT_URL: "postgres://x",
  CREDENTIALS_SECRET: Buffer.alloc(32, 1).toString("base64"),
  CRON_SECRET: "s",
  RESA_CLIENT_ID: "id",
  RESA_CLIENT_SECRET: "secret",
  ADMIN_EMAILS: "a@b.fr",
};

describe("assertProductionEnv — une production mal configurée ne se déploie pas", () => {
  it("configuration complète → passe", () => {
    expect(envProblems(OK)).toEqual([]);
    expect(() => assertProductionEnv(OK)).not.toThrow();
  });

  it("CREDENTIALS_SECRET absente → build refusé", () => {
    expect(() => assertProductionEnv({ ...OK, CREDENTIALS_SECRET: "" })).toThrow(/CREDENTIALS_SECRET manquante/);
  });

  it("CREDENTIALS_SECRET de mauvaise taille → build refusé", () => {
    expect(envProblems({ ...OK, CREDENTIALS_SECRET: "trop-court" })).toEqual([
      expect.stringContaining("32 octets"),
    ]);
  });

  it("aucun admin, planning factice → signalés", () => {
    const p = envProblems({ ...OK, ADMIN_EMAILS: "", RESA_USE_MOCK: "1" });
    expect(p).toHaveLength(2);
  });

  it("hors production (preview, local) → jamais bloquant", () => {
    expect(() => assertProductionEnv({ VERCEL_ENV: "preview" })).not.toThrow();
    expect(() => assertProductionEnv({})).not.toThrow();
  });
});
