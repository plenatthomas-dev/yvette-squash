import { describe, it, expect } from "vitest";
import {
  isAvailabilityStatus,
  parseComment,
  tally,
  isShortHanded,
  needsOverrideConfirm,
  MAX_AVAILABILITY_COMMENT,
  type AvailabilityEntry,
} from "./interclub-availability";

const entry = (over: Partial<AvailabilityEntry> = {}): AvailabilityEntry => ({
  key: "u1",
  name: "Alice",
  isMember: true,
  status: null,
  comment: null,
  relayedBy: null,
  reachable: true,
  ...over,
});

describe("isAvailabilityStatus", () => {
  it("accepte les trois états et rien d'autre", () => {
    expect(isAvailabilityStatus("yes")).toBe(true);
    expect(isAvailabilityStatus("no")).toBe(true);
    expect(isAvailabilityStatus("maybe")).toBe(true);
    expect(isAvailabilityStatus("peut-être")).toBe(false);
    expect(isAvailabilityStatus(null)).toBe(false);
    expect(isAvailabilityStatus(1)).toBe(false);
  });
});

describe("parseComment", () => {
  it("compacte les blancs et rend null sur du vide", () => {
    expect(parseComment("  je peux   après 20h30 ")).toBe("je peux après 20h30");
    expect(parseComment("   ")).toBeNull();
    expect(parseComment(undefined)).toBeNull();
  });

  it("tronque plutôt que de refuser", () => {
    // Un commentaire trop long est une maladresse, pas une faute : le refuser ferait perdre
    // la réponse elle-même, qui est ce qui compte.
    expect(parseComment("a".repeat(400))).toHaveLength(MAX_AVAILABILITY_COMMENT);
  });
});

describe("tally", () => {
  it("compte les trois états", () => {
    const t = tally([
      entry({ key: "a", status: "yes" }),
      entry({ key: "b", status: "yes" }),
      entry({ key: "c", status: "no" }),
      entry({ key: "d", status: "maybe" }),
    ]);
    expect(t).toMatchObject({ yes: 2, no: 1, maybe: 1 });
    expect(t.pendingReachable).toEqual([]);
    expect(t.pendingUnreachable).toEqual([]);
  });

  it("sépare les silencieux JOIGNABLES de ceux qu'aucune relance n'atteindra", () => {
    // C'est le cœur du dispositif : relancer par notification quelqu'un qui n'en reçoit pas ne
    // coûte rien mais ne produit rien, et laisse croire que le travail est fait.
    const t = tally([
      entry({ key: "a", name: "Alice", reachable: true }),
      entry({ key: "guest:g1", name: "Paul Hors-Appli", isMember: false, reachable: false }),
      entry({ key: "b", name: "Bob", reachable: false }), // membre sans notifications
    ]);
    expect(t.pendingReachable.map((e) => e.name)).toEqual(["Alice"]);
    expect(t.pendingUnreachable.map((e) => e.name)).toEqual(["Paul Hors-Appli", "Bob"]);
  });
});

describe("isShortHanded", () => {
  it("alerte quand les dispos FERMES ne remplissent pas la feuille", () => {
    expect(isShortHanded(tally([entry({ key: "a", status: "yes" })]), 4)).toBe(true);
  });

  it("ne compte PAS les incertains comme des présents", () => {
    // Les compter ferait taire l'alerte le jour où elle est le plus utile : quatre « peut-être »
    // ne font pas une équipe.
    const t = tally([
      entry({ key: "a", status: "yes" }),
      entry({ key: "b", status: "maybe" }),
      entry({ key: "c", status: "maybe" }),
      entry({ key: "d", status: "maybe" }),
    ]);
    expect(isShortHanded(t, 4)).toBe(true);
  });

  it("se tait quand l'équipe est au complet", () => {
    const t = tally(["a", "b", "c", "d"].map((k) => entry({ key: k, status: "yes" })));
    expect(isShortHanded(t, 4)).toBe(false);
  });
});

describe("needsOverrideConfirm", () => {
  // La règle : on ne fait pas disparaître SANS LE VOIR une réponse que quelqu'un a donnée
  // lui-même. Ce n'est pas un verrou — le capitaine qui l'a eu au téléphone confirme et passe.
  const première = { userId: "u1", setById: "u1" }; // Alice a répondu elle-même
  const relais = { userId: "u1", setById: "u2" }; // Bob avait répondu pour Alice
  const invité = { userId: null, setById: "u2" };

  it("demande confirmation quand un tiers écrase une réponse de PREMIÈRE MAIN", () => {
    expect(needsOverrideConfirm(première, "u1", "u2")).toBe(true);
  });

  it("ne demande rien à l'intéressé qui se corrige", () => {
    expect(needsOverrideConfirm(première, "u1", "u1")).toBe(false);
  });

  it("ne demande rien pour remplacer un relais par un autre", () => {
    // Deux ouï-dire se valent : rien de première main n'est perdu.
    expect(needsOverrideConfirm(relais, "u1", "u3")).toBe(false);
  });

  it("ne demande rien sur une première réponse, qui ne remplace rien", () => {
    expect(needsOverrideConfirm(null, "u1", "u2")).toBe(false);
  });

  it("ne demande rien pour un joueur sans compte, qui ne répond jamais lui-même", () => {
    // Sa réponse est TOUJOURS relayée : exiger une confirmation à chaque fois ne protégerait
    // rien et ferait un clic de plus à chaque saisie.
    expect(needsOverrideConfirm(invité, null, "u2")).toBe(false);
  });
});
