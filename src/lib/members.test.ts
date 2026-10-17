import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Chaque `count` de `deleteBlockersFor` est ENREGISTRÉ (modèle + where), puis rapproché des
// relations que le schéma déclare bloquantes. Le mock rend des valeurs propres à chaque modèle
// pour qu'une somme ou une clé mal branchée se voie aussi.
const h = vi.hoisted(() => ({
  calls: [] as { model: string; where: unknown }[],
  counts: {} as Record<string, number>,
}));

vi.mock("./db", () => ({
  prisma: new Proxy(
    {},
    {
      get: (_t, model: string) => ({
        count: vi.fn(async (args: { where: unknown }) => {
          h.calls.push({ model, where: args.where });
          return h.counts[model] ?? 0;
        }),
      }),
    },
  ),
}));

import { deleteBlockersFor, deleteBlockersMessage } from "./members";

beforeEach(() => {
  h.calls = [];
  h.counts = {};
});

// ─── LECTURE DU SCHÉMA ──────────────────────────────────────────────────────────────────────
//
// Une relation vers `User` BLOQUE la suppression du membre quand son `onDelete` est `Restrict`
// ou `NoAction` (en Postgres, les deux refusent la suppression d'une ligne encore référencée ;
// seul le moment du contrôle diffère). Sans `onDelete` explicite, Prisma applique `Restrict`
// à une relation REQUISE (`User`) et `SetNull` à une relation optionnelle (`User?`) — le défaut
// est donc lui aussi pris en compte, car c'est précisément le cas qu'on oublie en relisant.

type Relation = { model: string; field: string; fk: string; onDelete: string };

function relationsVersUser(): Relation[] {
  const schema = readFileSync(
    fileURLToPath(new URL("../../prisma/schema.prisma", import.meta.url)),
    "utf8",
  );
  const out: Relation[] = [];
  let model: string | null = null;
  for (const brute of schema.split(/\r?\n/)) {
    const ligne = brute.replace(/\/\/.*$/, "").trim();
    const debut = /^model\s+(\w+)\s*\{/.exec(ligne);
    if (debut) {
      model = debut[1];
      continue;
    }
    if (ligne === "}") {
      model = null;
      continue;
    }
    if (!model) continue;
    // `champ User[?] @relation(... fields: [fk] ...)` — les listes (`User[]`) et les côtés sans
    // `fields` ne portent pas la clé étrangère : ils ne contraignent rien.
    const m = /^(\w+)\s+User(\?)?\s+.*@relation\((.*)\)/.exec(ligne);
    if (!m) continue;
    const fields = /fields:\s*\[(\w+)\]/.exec(m[3]);
    if (!fields) continue;
    const explicite = /onDelete:\s*(\w+)/.exec(m[3])?.[1];
    const onDelete = explicite ?? (m[2] ? "SetNull" : "Restrict");
    out.push({ model, field: m[1], fk: fields[1], onDelete });
  }
  return out;
}

/** `where` (même imbriqué dans des OR/AND) contient-il `{ [fk]: userId }` ? */
function contientFiltre(where: unknown, fk: string, userId: string): boolean {
  if (Array.isArray(where)) return where.some((w) => contientFiltre(w, fk, userId));
  if (!where || typeof where !== "object") return false;
  return Object.entries(where as Record<string, unknown>).some(([k, v]) =>
    k === fk ? v === userId : contientFiltre(v, fk, userId),
  );
}

const lcfirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

describe("deleteBlockersFor ↔ prisma/schema.prisma", () => {
  it("le schéma est bien lu (garde-fou du test lui-même)", () => {
    const rels = relationsVersUser();
    // Une lecture cassée rendrait une liste vide, et le test suivant passerait sans rien voir.
    expect(rels.length).toBeGreaterThan(20);
    expect(rels).toContainEqual({
      model: "Session",
      field: "user",
      fk: "userId",
      onDelete: "Cascade",
    });
  });

  it("chaque relation bloquante vers User est comptée par deleteBlockersFor", async () => {
    const bloquantes = relationsVersUser().filter(
      (r) => r.onDelete === "Restrict" || r.onDelete === "NoAction",
    );
    // L'état connu à ce jour, écrit en clair : une nouvelle relation bloquante fera échouer ce
    // test-ci ET le suivant — le premier dit qu'elle existe, le second si elle est couverte.
    expect(bloquantes.map((r) => `${r.model}.${r.fk}`).sort()).toEqual([
      "Expense.creatorId",
      "Expense.payerId",
      "ExpenseShare.userId",
      "Interclub.createdById",
      "Tournament.createdById",
    ]);

    await deleteBlockersFor("u-cible");
    const nonCouvertes = bloquantes.filter(
      (r) =>
        !h.calls.some(
          (c) => c.model === lcfirst(r.model) && contientFiltre(c.where, r.fk, "u-cible"),
        ),
    );
    expect(nonCouvertes).toEqual([]);
  });
});

describe("deleteBlockersFor", () => {
  it("compte les rencontres interclub créées, et les ajoute au total", async () => {
    h.counts = { expense: 2, expenseShare: 3, tournament: 1, interclub: 4 };
    expect(await deleteBlockersFor("u1")).toEqual({
      expenses: 2,
      shares: 3,
      tournaments: 1,
      interclubs: 4,
      total: 10,
    });
  });

  it("total 0 quand rien ne bloque", async () => {
    expect((await deleteBlockersFor("u1")).total).toBe(0);
  });
});

describe("deleteBlockersMessage", () => {
  const zero = { expenses: 0, shares: 0, tournaments: 0, interclubs: 0 };

  it("nomme ce qui bloque, au singulier comme au pluriel", () => {
    expect(deleteBlockersMessage({ ...zero, interclubs: 1 })).toBe(
      "Suppression impossible : ce membre a une rencontre interclub créée. Désactive-le plutôt.",
    );
    expect(deleteBlockersMessage({ ...zero, shares: 2, tournaments: 2, interclubs: 3 })).toBe(
      "Suppression impossible : ce membre a des dépenses Tricount, des tournois créés et des " +
        "rencontres interclub créées. Désactive-le plutôt.",
    );
  });
});
