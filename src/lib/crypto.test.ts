import { describe, it, expect, beforeAll } from "vitest";
import crypto from "node:crypto";
import { hashPassword, verifyPassword, hashToken, encrypt, decrypt, hashSessionId, tokenHashCandidates } from "./crypto";

describe("hashPassword / verifyPassword", () => {
  it("round-trip : le bon mot de passe est accepté", async () => {
    const hash = await hashPassword("corr3ct-horse");
    expect(await verifyPassword("corr3ct-horse", hash)).toBe(true);
  });

  it("rejette un mauvais mot de passe", async () => {
    const hash = await hashPassword("corr3ct-horse");
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("format scrypt attendu, avec sel aléatoire (2 hachages du même mdp diffèrent)", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a.startsWith("scrypt$")).toBe(true);
    expect(a).not.toBe(b); // sels différents → chaînes différentes
    // …mais tous deux valident le mot de passe.
    expect(await verifyPassword("same-password", a)).toBe(true);
    expect(await verifyPassword("same-password", b)).toBe(true);
  });

  it("ne lève jamais sur une chaîne stockée illisible → renvoie false", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "pas-un-hash")).toBe(false);
    expect(await verifyPassword("x", "scrypt$16384$8$1$badbase64")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$1$2$3$4$5")).toBe(false);
  });
});

describe("hashToken", () => {
  beforeAll(() => {
    // getKey() lit CREDENTIALS_SECRET (32 octets base64) — fixé pour le test.
    process.env.CREDENTIALS_SECRET = Buffer.alloc(32, 7).toString("base64");
  });

  it("déterministe et distinct selon l'entrée", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(hashToken("abc")).not.toBe(hashToken("abd"));
    // HMAC-SHA256 → 64 caractères hexadécimaux.
    expect(hashToken("abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});

// Audit 2026-10, point 24 : une sous-clé par usage, et rien de cassé pour l'existant.
describe("une clé par usage", () => {
  beforeAll(() => {
    process.env.CREDENTIALS_SECRET = Buffer.alloc(32, 7).toString("base64");
  });
  const brute = () => Buffer.alloc(32, 7);

  it("chiffre au format courant (`v2.`) et relit ce qu'il a chiffré", () => {
    const c = encrypt("jeton");
    expect(c.startsWith("v2.")).toBe(true);
    expect(decrypt(c)).toBe("jeton");
  });

  it("relit encore un chiffré d'AVANT la dérivation (clé brute, sans préfixe)", () => {
    const iv = crypto.randomBytes(12);
    const ci = crypto.createCipheriv("aes-256-gcm", brute(), iv);
    const data = Buffer.concat([ci.update("ancien", "utf8"), ci.final()]);
    const ancien = [iv, ci.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
    expect(decrypt(ancien)).toBe("ancien");
  });

  it("le HMAC des jetons n'utilise plus la clé brute ; l'ancienne empreinte reste reconnue", () => {
    const ancien = crypto.createHmac("sha256", brute()).update("tok").digest("hex");
    expect(hashToken("tok")).not.toBe(ancien);
    expect(tokenHashCandidates("tok")).toEqual([hashToken("tok"), ancien]);
  });

  it("l'identifiant de session stocké est une empreinte, distincte du cookie et du HMAC des jetons", () => {
    const k = hashSessionId("cookie");
    expect(k.startsWith("h:")).toBe(true);
    expect(k).not.toContain("cookie");
    expect(k).toBe(hashSessionId("cookie"));
    expect(k.slice(2)).not.toBe(Buffer.from(hashToken("cookie"), "hex").toString("base64url"));
  });
});
