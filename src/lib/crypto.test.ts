import { describe, it, expect, beforeAll } from "vitest";
import { hashPassword, verifyPassword, hashToken } from "./crypto";

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
