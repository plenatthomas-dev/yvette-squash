import { describe, it, expect, vi } from "vitest";
import type { AppSession } from "./session";

// « Email seul » = aucun ResaMania rattaché. PAS un compte ResaMania dont le jeton est
// momentanément irrafraîchissable (`resaUnavailable`, panne passagère) : sans cette nuance, une
// panne de ResaMania retirait à un membre la gestion de ses dépenses, avec le message « Compte
// email seul ».

vi.mock("@/lib/db", () => ({ prisma: {} }));

import { isEmailOnly, blockEmailOnlyExpenseWrite } from "./tricount-guard";

const base = { userId: "u1", displayName: "Alice", email: "a@example.fr" };
const resamania: AppSession = { ...base, resa: { accessToken: "tok" } as never };
const emailSeul: AppSession = { ...base, resa: null };
const resaEnPanne: AppSession = { ...base, resa: null, resaUnavailable: true };

describe("isEmailOnly", () => {
  it("compte sans ResaMania → email seul", () => {
    expect(isEmailOnly(emailSeul)).toBe(true);
  });

  it("compte ResaMania au jeton valide → pas email seul", () => {
    expect(isEmailOnly(resamania)).toBe(false);
  });

  it("compte ResaMania pendant une panne passagère → pas email seul", () => {
    expect(isEmailOnly(resaEnPanne)).toBe(false);
  });
});

describe("blockEmailOnlyExpenseWrite", () => {
  it("laisse écrire un membre ResaMania pendant une panne de ResaMania", () => {
    expect(blockEmailOnlyExpenseWrite(resaEnPanne)).toBeNull();
  });

  it("refuse toujours (403) un vrai compte email seul", () => {
    expect(blockEmailOnlyExpenseWrite(emailSeul)?.status).toBe(403);
  });
});
