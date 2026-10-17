import { describe, it, expect, beforeEach, vi } from "vitest";

// Un VRAI journal en mémoire, qui honore `ip`, `identifier` et les bornes `gte`/`lt` de
// `createdAt` : c'est sa cohabitation avec les autres lecteurs de `LoginAttempt` qu'on mesure,
// et un mock qui rendrait un chiffre fixe répondrait à la place de la base.
type Ligne = { ip: string; identifier: string | null; createdAt: Date };
const h = vi.hoisted(() => ({ lignes: [] as Ligne[] }));

type Where = {
  ip?: string;
  identifier?: string;
  createdAt?: { gte?: Date; lt?: Date };
  OR?: Where[];
};
function correspond(l: Ligne, w: Where): boolean {
  if (w.OR) return w.OR.some((x) => correspond(l, x));
  if (w.ip !== undefined && l.ip !== w.ip) return false;
  if (w.identifier !== undefined && l.identifier !== w.identifier) return false;
  if (w.createdAt?.gte && l.createdAt < w.createdAt.gte) return false;
  if (w.createdAt?.lt && !(l.createdAt < w.createdAt.lt)) return false;
  return true;
}

vi.mock("./db", () => ({
  prisma: {
    loginAttempt: {
      create: vi.fn(async ({ data }: { data: { ip: string; identifier: string } }) => {
        h.lignes.push({ ...data, createdAt: new Date() });
        return {};
      }),
      count: vi.fn(async ({ where }: { where: Where }) =>
        h.lignes.filter((l) => correspond(l, where)).length,
      ),
      deleteMany: vi.fn(async ({ where }: { where: Where }) => {
        const avant = h.lignes.length;
        h.lignes = h.lignes.filter((l) => !correspond(l, where));
        return { count: avant - h.lignes.length };
      }),
    },
  },
}));

import { gesteRefuse, GESTE_IP, FENETRE_MAX_MS } from "./geste-debit";

const FENETRE = 10 * 60_000;

beforeEach(() => {
  h.lignes = [];
});

describe("gesteRefuse", () => {
  it("bascule ×N : laisse passer N gestes, refuse le suivant", async () => {
    for (let i = 0; i < 5; i++) {
      expect(await gesteRefuse("forum-vote:u1", FENETRE, 5)).toBe(false);
    }
    expect(await gesteRefuse("forum-vote:u1", FENETRE, 5)).toBe(true);
    // Le geste refusé n'est pas journalisé : insister ne repousse pas la sortie de fenêtre.
    expect(h.lignes).toHaveLength(5);
  });

  it("compte par clé : un autre membre, ou un autre geste, a son propre compteur", async () => {
    for (let i = 0; i < 3; i++) await gesteRefuse("forum-vote:u1", FENETRE, 3);
    expect(await gesteRefuse("forum-vote:u1", FENETRE, 3)).toBe(true);
    expect(await gesteRefuse("forum-vote:u2", FENETRE, 3)).toBe(false);
    expect(await gesteRefuse("forum-react:u1", FENETRE, 3)).toBe(false);
  });

  it("oublie les gestes sortis de la fenêtre, et purge les siens", async () => {
    const vieux = new Date(Date.now() - FENETRE - 1000);
    h.lignes = Array.from({ length: 5 }, () => ({
      ip: GESTE_IP, identifier: "forum-vote:u1", createdAt: vieux,
    }));
    expect(await gesteRefuse("forum-vote:u1", FENETRE, 5)).toBe(false);
    expect(h.lignes).toHaveLength(1);
  });

  it("ne compte PAS un échec de connexion qui aurait tapé notre clé comme identifiant", async () => {
    // Un inconnu qui saisit « forum-vote:u1 » comme login écrit, à chaque échec, une ligne de
    // notre clé — avec son IP réelle. Elle ne doit ni remplir le compteur du membre, ni être
    // effacée par notre purge (elle appartient au comptage anti-force-brute).
    const vieux = new Date(Date.now() - FENETRE - 1000);
    h.lignes = [
      ...Array.from({ length: 5 }, () => ({
        ip: "203.0.113.7", identifier: "forum-vote:u1", createdAt: new Date(),
      })),
      { ip: "203.0.113.7", identifier: "forum-vote:u1", createdAt: vieux },
    ];
    expect(await gesteRefuse("forum-vote:u1", FENETRE, 5)).toBe(false);
    expect(h.lignes.filter((l) => l.ip === "203.0.113.7")).toHaveLength(6);
  });

  it("refuse une fenêtre plus longue que la purge des connexions (15 min)", async () => {
    await expect(gesteRefuse("forum-vote:u1", FENETRE_MAX_MS + 1, 5)).rejects.toThrow(/trop longue/);
  });
});

describe("cohabitation avec l'anti-force-brute des connexions", () => {
  it("nos lignes n'entrent dans AUCUN des deux comptages du login, ni dans son effacement", async () => {
    for (let i = 0; i < 50; i++) await gesteRefuse("forum-vote:u1", FENETRE, 100);
    const depuis = new Date(Date.now() - 15 * 60_000);
    // Les requêtes exactes d'api/auth/login et api/auth/email/login : par IP réelle (ou
    // « local » sans en-tête), et par identifiant normalisé (login ou e-mail).
    for (const ip of ["203.0.113.7", "local"]) {
      expect(h.lignes.filter((l) => correspond(l, { ip, createdAt: { gte: depuis } }))).toHaveLength(0);
    }
    for (const identifier of ["membre@example.com", "membre", "u1"]) {
      expect(
        h.lignes.filter((l) => correspond(l, { identifier, createdAt: { gte: depuis } })),
      ).toHaveLength(0);
    }
    // L'effacement après connexion réussie les épargne, sous ses deux formes : le couple
    // `{ ip, identifier }` comme l'ancien `OR: [{ ip }, { identifier }]`.
    const avant = h.lignes.length;
    for (const w of [
      { ip: "203.0.113.7", identifier: "membre@example.com" },
      { OR: [{ ip: "203.0.113.7" }, { identifier: "membre@example.com" }] },
    ]) {
      h.lignes = h.lignes.filter((l) => !correspond(l, w));
    }
    expect(h.lignes).toHaveLength(avant);
  });
});
