import { describe, it, expect, beforeEach, vi } from "vitest";

// L'EMAIL RESAMANIA NE DOIT PAS ÉCRASER CELUI D'UN AUTRE COMPTE.
//
// `resolveUser` étape 1 (membre retrouvé par contactId) recopiait l'email ResaMania sur la
// ligne locale. Si le membre a changé d'adresse chez ResaMania pour une adresse déjà portée
// par une AUTRE ligne User (typiquement un compte « email seul » ouvert entre-temps),
// l'update violait `User.email @unique` (P2002) : createSession levait, et la connexion — bon
// mot de passe compris — échouait à chaque essai, comptée de surcroît comme tentative ratée.

const h = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
    id: args.where.id,
    ...args.data,
  })),
}));

vi.mock("./db", () => ({
  prisma: { user: { findUnique: h.findUnique, update: h.update, create: vi.fn() } },
}));
vi.mock("./crypto", () => ({ encrypt: (s: string) => s, decrypt: (s: string) => s }));
vi.mock("./resamania/client", () => ({ ensureFresh: vi.fn() }));

import { resolveUser } from "./session";

const membre = {
  id: "u-resa",
  contactId: "/t/contacts/9",
  email: "ancienne@example.fr",
  emailVerifiedAt: new Date("2026-01-01"),
};

beforeEach(() => {
  h.findUnique.mockReset();
  h.update.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("resolveUser — étape 1 (jointure par contactId)", () => {
  it("garde l'ancienne adresse si la nouvelle appartient à une AUTRE ligne", async () => {
    h.findUnique.mockImplementation(async ({ where }: { where: { contactId?: string; email?: string } }) => {
      if (where.contactId) return membre;
      if (where.email === "nouvelle@example.fr") return { id: "u-email-seul" };
      return null;
    });

    await resolveUser({ displayName: "Alice", email: "Nouvelle@Example.fr", contactId: membre.contactId });

    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u-resa" }, data: expect.objectContaining({ email: "ancienne@example.fr" }) }),
    );
    expect(console.warn).toHaveBeenCalled();
  });

  it("adopte la nouvelle adresse quand personne d'autre ne la porte", async () => {
    h.findUnique.mockImplementation(async ({ where }: { where: { contactId?: string } }) =>
      where.contactId ? membre : null,
    );

    await resolveUser({ displayName: "Alice", email: "nouvelle@example.fr", contactId: membre.contactId });

    expect(h.update.mock.calls[0][0].data.email).toBe("nouvelle@example.fr");
  });

  it("adresse inchangée → aucune lecture supplémentaire (chemin courant de chaque connexion)", async () => {
    h.findUnique.mockImplementation(async () => membre);

    await resolveUser({ displayName: "Alice", email: "ancienne@example.fr", contactId: membre.contactId });

    expect(h.findUnique).toHaveBeenCalledTimes(1); // la seule jointure par contactId
    expect(h.update.mock.calls[0][0].data.email).toBe("ancienne@example.fr");
  });
});
