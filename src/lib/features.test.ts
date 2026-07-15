import { describe, it, expect } from "vitest";
import {
  FEATURE_KEYS,
  isFeatureKey,
  parseOverrides,
  resolveFeatures,
  type Features,
} from "./features";

// Base d'environnement déterministe (on ne dépend pas des NEXT_PUBLIC_* de la machine de test).
const env: Features = {
  tricount: false,
  emailLogin: true,
  directory: false,
  delegation: false,
  tournament: false,
  ranking: true,
};

describe("resolveFeatures", () => {
  it("suit l'environnement quand aucun override n'est posé (« auto »)", () => {
    expect(resolveFeatures({}, env)).toEqual(env);
  });

  it("un override force la valeur, dans les deux sens", () => {
    const out = resolveFeatures({ tricount: true, ranking: false }, env);
    expect(out.tricount).toBe(true); // forcé ON alors que l'env dit OFF
    expect(out.ranking).toBe(false); // forcé OFF alors que l'env dit ON
    expect(out.emailLogin).toBe(true); // intact (pas d'override)
  });

  it("`false` est un override à part entière, pas une absence", () => {
    // Le piège classique d'un `||` : `false ?? env` doit rendre false, pas retomber sur l'env.
    expect(resolveFeatures({ emailLogin: false }, env).emailLogin).toBe(false);
  });

  it("renvoie toujours les clés connues, et seulement elles", () => {
    expect(Object.keys(resolveFeatures({}, env)).sort()).toEqual([...FEATURE_KEYS].sort());
  });
});

describe("parseOverrides", () => {
  it("ne garde que les clés connues à valeur booléenne", () => {
    const out = parseOverrides({
      tricount: true,
      ranking: false,
      inconnu: true, // clé hors périmètre
      directory: "oui", // type invalide
      tournament: 1, // type invalide
    });
    expect(out).toEqual({ tricount: true, ranking: false });
  });

  it("dégrade vers « aucun override » sur une entrée illisible", () => {
    // Une ligne corrompue en base doit rendre la main à l'env, jamais casser l'appli.
    for (const bad of [null, undefined, "banane", 42, []]) {
      expect(parseOverrides(bad)).toEqual({});
    }
  });

  it("un override vide laisse l'environnement décider", () => {
    expect(resolveFeatures(parseOverrides({}), env)).toEqual(env);
  });
});

describe("isFeatureKey", () => {
  it("accepte les clés connues et rejette le reste", () => {
    expect(isFeatureKey("tricount")).toBe(true);
    expect(isFeatureKey("inconnu")).toBe(false);
    expect(isFeatureKey(42)).toBe(false);
    expect(isFeatureKey(null)).toBe(false);
  });
});
