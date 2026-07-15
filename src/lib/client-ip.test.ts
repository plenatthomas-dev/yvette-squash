import { describe, it, expect } from "vitest";
import type { NextRequest } from "next/server";
import { clientIp } from "./client-ip";

// Le point de tout ce module : un client peut ENVOYER un x-forwarded-for. Si on lui fait
// confiance, il randomise l'en-tête et tout compteur « par IP » (anti-brute-force du login,
// anti-spam des envois) reste à zéro. On ne croit que ce que la plateforme a posé.

const req = (headers: Record<string, string>) =>
  ({ headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } }) as unknown as NextRequest;

describe("clientIp", () => {
  it("préfère x-real-ip (posé par la plateforme)", () => {
    expect(clientIp(req({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "1.1.1.1" }))).toBe("9.9.9.9");
  });

  it("à défaut, prend la DERNIÈRE entrée de x-forwarded-for", () => {
    expect(clientIp(req({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 9.9.9.9" }))).toBe("9.9.9.9");
  });

  it("ignore une IP injectée en tête de chaîne par l'attaquant", () => {
    // L'attaquant envoie « x-forwarded-for: <aléatoire> », la plateforme ajoute la vraie à la
    // suite. Prendre [0] renverrait la valeur choisie par l'attaquant → compteur toujours neuf.
    const forge = clientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }));
    expect(forge).toBe("203.0.113.7");
    expect(forge).not.toBe("6.6.6.6");
  });

  it("x-real-ip l'emporte même si l'attaquant forge un x-forwarded-for entier", () => {
    expect(
      clientIp(req({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "6.6.6.6, 6.6.6.6" })),
    ).toBe("203.0.113.7");
  });

  it("tolère les espaces et les entrées vides", () => {
    expect(clientIp(req({ "x-forwarded-for": " 1.1.1.1 ,  , 9.9.9.9 " }))).toBe("9.9.9.9");
  });

  it("sans en-tête : « local » — tout le monde partage le compteur (le plus STRICT)", () => {
    expect(clientIp(req({}))).toBe("local");
    expect(clientIp(req({ "x-forwarded-for": "" }))).toBe("local");
  });
});
