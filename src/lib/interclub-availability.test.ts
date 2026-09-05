import { describe, it, expect } from "vitest";
import {
  isAvailabilityStatus,
  parseComment,
  tally,
  isShortHanded,
  needsOverrideConfirm,
  daysBetween,
  dueAction,
  type ScheduledFixture,
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

// LE CALENDRIER DES RELANCES — la seule règle de ce module qui décide d'un ENVOI.
//
// Elle n'était éprouvée qu'à travers le cron, dont le faux `interclub.findMany` ignore son
// `where` : les cas « rencontre passée » et « date non confirmée » y mesuraient bien `dueAction`,
// mais rien ne tenait les BORNES des deux fenêtres, ni le comptage de jours autour d'un
// changement d'heure — que le commentaire de `daysBetween` donne pourtant comme sa raison d'être.

describe("daysBetween", () => {
  it("compte des jours de CALENDRIER, pas des durées", () => {
    expect(daysBetween("2026-10-01", "2026-10-11")).toBe(10);
    expect(daysBetween("2026-10-11", "2026-10-01")).toBe(-10);
    expect(daysBetween("2026-10-09", "2026-10-09")).toBe(0);
  });

  it("ne bouge pas d'un jour au changement d'heure", () => {
    // Le passage à l'heure d'hiver 2026 en France a lieu le 25 octobre. Compté en instants, le
    // 26 octobre est à 10 jours et 1 heure du 16 : arrondi vers le bas, la relance serait
    // partie un jour trop tôt — deux fois par an, sur une poignée de rencontres.
    expect(daysBetween("2026-10-16", "2026-10-26")).toBe(10);
    expect(daysBetween("2026-03-26", "2026-04-05")).toBe(10);
  });

  it("rend NaN sur une date illisible plutôt qu'un nombre inventé", () => {
    expect(Number.isNaN(daysBetween("pas une date", "2026-10-09"))).toBe(true);
  });
});

describe("dueAction", () => {
  const rencontre = (over: Partial<ScheduledFixture> = {}): ScheduledFixture => ({
    date: "2026-10-09",
    dateConfirmed: true,
    availabilityOpenedAt: null,
    availabilityRemindedAt: null,
    ...over,
  });

  it("RIEN sur une date non confirmée, quelle que soit l'échéance", () => {
    // La fédération publie les journées non planifiées avec une date bouchon commune :
    // convoquer là-dessus enverrait l'équipe quatre fois le même soir, et lui apprendrait à
    // ignorer ces notifications.
    expect(dueAction(rencontre({ dateConfirmed: false }), "2026-10-08")).toBeNull();
  });

  it("ouvre l'appel à J-10 exactement, et pas à J-11", () => {
    // La borne est la règle : « assez tôt pour déplacer une soirée, assez tard pour qu'on sache
    // ce qu'on fait ce jeudi-là ». Un jour de trop et l'on ne récolte que des « incertain ».
    expect(dueAction(rencontre(), "2026-09-29")).toBe("call");
    expect(dueAction(rencontre(), "2026-09-28")).toBeNull();
  });

  it("relance à J-3 exactement, une fois l'appel ouvert", () => {
    const ouverte = rencontre({ availabilityOpenedAt: new Date("2026-09-29") });
    expect(dueAction(ouverte, "2026-10-06")).toBe("remind");
    expect(dueAction(ouverte, "2026-10-05")).toBeNull();
  });

  it("ne relance qu'UNE fois — c'est le marqueur qui porte l'idempotence", () => {
    // Sans lui, un cron quotidien redemanderait chaque matin à la même équipe si elle vient.
    const relancée = rencontre({
      availabilityOpenedAt: new Date("2026-09-29"),
      availabilityRemindedAt: new Date("2026-10-06"),
    });
    expect(dueAction(relancée, "2026-10-07")).toBeNull();
    expect(dueAction(relancée, "2026-10-08")).toBeNull();
  });

  it("RIEN sur une rencontre passée, même jamais appelée", () => {
    // Le jour même compte encore — on peut toujours chercher un remplaçant à 18 h.
    expect(dueAction(rencontre(), "2026-10-09")).toBe("call");
    expect(dueAction(rencontre(), "2026-10-10")).toBeNull();
  });
});
