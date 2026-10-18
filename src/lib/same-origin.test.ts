import { describe, it, expect } from "vitest";
import { isSameOriginRequest } from "./same-origin";

const req = (h: Record<string, string>) =>
  ({ headers: { get: (k: string) => h[k.toLowerCase()] ?? null } }) as unknown as Parameters<
    typeof isSameOriginRequest
  >[0];

describe("isSameOriginRequest — pas de connexion forcée depuis un autre site", () => {
  it("Sec-Fetch-Site same-origin ou none → passe", () => {
    expect(isSameOriginRequest(req({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOriginRequest(req({ "sec-fetch-site": "none" }))).toBe(true);
  });

  it("Sec-Fetch-Site cross-site ou same-site → refusé", () => {
    expect(isSameOriginRequest(req({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isSameOriginRequest(req({ "sec-fetch-site": "same-site" }))).toBe(false);
  });

  it("à défaut, Origin doit être notre hôte", () => {
    expect(isSameOriginRequest(req({ origin: "https://club.fr", host: "club.fr" }))).toBe(true);
    expect(isSameOriginRequest(req({ origin: "https://evil.example", host: "club.fr" }))).toBe(false);
    expect(
      isSameOriginRequest(req({ origin: "https://club.fr", host: "interne", "x-forwarded-host": "club.fr" })),
    ).toBe(true);
  });

  it("aucun en-tête (outil, vieux navigateur) → passe", () => {
    expect(isSameOriginRequest(req({}))).toBe(true);
  });
});
