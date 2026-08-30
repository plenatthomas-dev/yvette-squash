import { describe, it, expect, afterEach, vi } from "vitest";

// L'ALLOWLIST ADMIN, ET SON DÉFAUT FERMÉ.
//
// `isAdminEmail` décide de l'accès à l'espace d'administration, et — depuis la branche
// interclub — de trois autorisations de plus : voir le roster complet d'une rencontre, modifier
// un match entamé qui ne vous appartient pas, supprimer une rencontre créée par un autre.
//
// Ces trois-là l'appellent avec `session.email`, qui vaut `null` pour un compte ResaMania sans
// adresse connue. Le passage d'une valeur nulle sur un chemin d'AUTORISATION est exactement le
// genre de détail qui, mal traité, ouvre tout : `new Set().has(undefined)` ne lève pas, il rend
// `false` — mais une comparaison mal écrite pourrait rendre autre chose. Rien ne le vérifiait.
//
// L'autre moitié du sujet est le fail-safe de la liste elle-même : sans `ADMIN_EMAILS`,
// PERSONNE n'est admin. Une allowlist qui s'ouvrirait quand elle est vide serait le pire des
// défauts imaginables ici, et le plus silencieux — tout marcherait, pour tout le monde.

vi.mock("./db", () => ({ prisma: {} }));
vi.mock("./push", () => ({ pushToUser: vi.fn(), pushConfigured: () => false }));

import { isAdminEmail } from "./admin";

const ORIGINE = process.env.ADMIN_EMAILS;

afterEach(() => {
  if (ORIGINE === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = ORIGINE;
});

describe("isAdminEmail — le défaut est fermé", () => {
  it("refuse une adresse ABSENTE, ce que la session rend pour un compte sans e-mail", async () => {
    // Le cas ajouté par la branche interclub : `isAdminEmail(session.email)` où `email` est
    // `null`. Les trois formes de « rien » doivent se comporter pareil.
    process.env.ADMIN_EMAILS = "chef@exemple.fr";
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
    expect(isAdminEmail("")).toBe(false);
  });

  it("refuse TOUT LE MONDE quand l'allowlist est absente ou vide", async () => {
    // Une allowlist vide qui ouvrirait au lieu de fermer serait invisible : l'appli marcherait,
    // pour tout le monde, avec les droits d'admin.
    delete process.env.ADMIN_EMAILS;
    expect(isAdminEmail("chef@exemple.fr")).toBe(false);

    process.env.ADMIN_EMAILS = "   ";
    expect(isAdminEmail("chef@exemple.fr")).toBe(false);
  });

  it("refuse une adresse hors liste", async () => {
    process.env.ADMIN_EMAILS = "chef@exemple.fr";
    expect(isAdminEmail("quidam@exemple.fr")).toBe(false);
  });
});

describe("isAdminEmail — ce qu'elle accepte", () => {
  it("reconnaît une adresse listée, quelles que soient casse et espaces", async () => {
    // L'adresse arrive de deux sources différentes (ResaMania, saisie manuelle) et la variable
    // d'env est écrite à la main dans Vercel : les deux côtés sont normalisés.
    process.env.ADMIN_EMAILS = "  Chef@Exemple.FR ";
    expect(isAdminEmail("chef@exemple.fr")).toBe(true);
    expect(isAdminEmail("  CHEF@exemple.fr  ")).toBe(true);
  });

  it("accepte les trois séparateurs de liste : virgule, espace, point-virgule", async () => {
    process.env.ADMIN_EMAILS = "un@exemple.fr, deux@exemple.fr;trois@exemple.fr quatre@exemple.fr";
    for (const e of ["un", "deux", "trois", "quatre"]) {
      expect(isAdminEmail(`${e}@exemple.fr`)).toBe(true);
    }
    expect(isAdminEmail("cinq@exemple.fr")).toBe(false);
  });

  it("relit la variable à CHAQUE appel — la liste change sans redéploiement de l'appli", async () => {
    // `ADMIN_EMAILS` n'est pas `NEXT_PUBLIC_*` : elle n'est pas inlinée au build. La lire une
    // fois au chargement du module figerait la liste jusqu'au prochain démarrage.
    process.env.ADMIN_EMAILS = "avant@exemple.fr";
    expect(isAdminEmail("avant@exemple.fr")).toBe(true);
    process.env.ADMIN_EMAILS = "apres@exemple.fr";
    expect(isAdminEmail("avant@exemple.fr")).toBe(false);
    expect(isAdminEmail("apres@exemple.fr")).toBe(true);
  });
});
