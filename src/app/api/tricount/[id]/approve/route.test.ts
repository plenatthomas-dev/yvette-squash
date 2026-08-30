import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// « OK POUR REMBOURSER » — la promesse la plus explicite du tricount, et elle n'avait aucun test.
//
// L'en-tête de la route l'écrit noir sur blanc : « Quand tous les payeurs ont validé, les
// remboursements s'ouvrent. À CE MOMENT-LÀ (et seulement à la transition), on notifie par push
// les débiteurs […] l'utilisateur qui valide n'est pas notifié. »
//
// Quatre conditions y sont empilées, et chacune casse en silence : notifier à chaque validation
// harcèle, ne notifier jamais laisse tout le monde attendre, notifier le valideur le déroute,
// et notifier un invité échoue sans bruit (il n'a pas de compte). Aucune ne se voit dans une
// réponse HTTP — elles ne se voient que dans ce qui part, ou ne part pas, en notification.
//
// On utilise le VRAI `computeBalances` et le vrai `payersOf` : ce sont eux qui décident qui est
// débiteur, et une copie dans le test ne prouverait rien sur la route.

const h = vi.hoisted(() => ({
  session: null as null | { userId: string; displayName: string; resa: unknown },
  tricountOn: true,
  tricount: null as null | Record<string, unknown>,
  upsert: vi.fn(),
  push: vi.fn(async () => {}),
}));

vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/features-server", () => ({ getFeatures: async () => ({ tricount: h.tricountOn }) }));
vi.mock("@/lib/push", () => ({ pushToUser: h.push }));
vi.mock("@/lib/db", () => ({
  prisma: {
    tricount: { findUnique: vi.fn(async () => h.tricount) },
    tricountApproval: { upsert: h.upsert },
  },
}));

import { POST } from "./route";

const req = () => ({ cookies: { get: () => ({ value: "sid" }) } }) as unknown as NextRequest;
const ctx = { params: Promise.resolve({ id: "t1" }) };
const session = (userId: string) => ({ userId, displayName: userId, resa: { accessToken: "t" } });

/** Une dépense payée par `payer`, partagée à parts égales entre `entre`. */
function depense(payer: string, montant: number, entre: string[]) {
  const part = Math.floor(montant / entre.length);
  return {
    payerId: payer.startsWith("g") ? null : payer,
    payerGuestId: payer.startsWith("g") ? payer : null,
    isRefund: false,
    shares: entre.map((k) => ({
      userId: k.startsWith("g") ? null : k,
      guestId: k.startsWith("g") ? k : null,
      amountCents: part,
    })),
  };
}

/** Le tricount du 3 septembre, avec ses dépenses et les validations déjà données. */
function tricount(expenses: unknown[], approvals: string[]) {
  return {
    id: "t1",
    date: "2026-09-03",
    expenses,
    approvals: approvals.map((userId) => ({ userId })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.session = session("u1");
  h.tricountOn = true;
  // Un seul payeur (u1), un seul débiteur (u2) qui doit 15,00 €.
  h.tricount = tricount([depense("u1", 3000, ["u1", "u2"])], []);
});

describe("POST /api/tricount/[id]/approve — les gardes", () => {
  it("répond 404 quand la fonction est coupée", async () => {
    h.tricountOn = false;
    expect((await POST(req(), ctx)).status).toBe(404);
  });

  it("répond 401 sans session", async () => {
    h.session = null;
    expect((await POST(req(), ctx)).status).toBe(401);
  });

  it("répond 404 sur un tricount inconnu", async () => {
    h.tricount = null;
    expect((await POST(req(), ctx)).status).toBe(404);
  });

  it("répond 403 à qui n'est PAS payeur — un débiteur ne valide pas", async () => {
    // La validation est celle des payeurs : celui qui doit de l'argent n'a rien à autoriser.
    h.session = session("u2");
    const res = await POST(req(), ctx);
    expect(res.status).toBe(403);
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
  });
});

describe("POST /api/tricount/[id]/approve — la transition, et elle seule", () => {
  it("notifie les débiteurs quand la DERNIÈRE validation manquante arrive", async () => {
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(h.push).toHaveBeenCalledTimes(1);
    const [userId, payload] = h.push.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(userId).toBe("u2");
    expect(payload.body).toContain("15,00 €");
    expect(payload.body).toContain("jeudi 3 septembre");
    expect(payload.url).toBe("/?view=money");
  });

  it("ne notifie PAS celui qui valide, même s'il est lui-même débiteur", async () => {
    // u2 paie 40 € pour tous, u1 paie 10 € pour tous : les deux sont payeurs, u1 est débiteur.
    h.tricount = tricount(
      [depense("u2", 4000, ["u1", "u2"]), depense("u1", 1000, ["u1", "u2"])],
      ["u2"],
    );
    h.session = session("u1"); // u1 valide en dernier ET doit de l'argent
    await POST(req(), ctx);
    expect(h.push).not.toHaveBeenCalled();
  });

  it("ne notifie PAS tant qu'un payeur n'a pas validé", async () => {
    h.tricount = tricount(
      [depense("u1", 3000, ["u1", "u2", "u3"]), depense("u2", 3000, ["u1", "u2", "u3"])],
      [],
    );
    await POST(req(), ctx); // u1 valide, u2 manque encore
    expect(h.upsert).toHaveBeenCalledTimes(1);
    expect(h.push).not.toHaveBeenCalled();
  });

  it("ne notifie PAS une seconde fois quand tout le monde avait déjà validé", async () => {
    // Revalider un tricount déjà prêt est sans effet visible : c'est ce qui rend le bouton
    // sûr à re-cliquer. Sans ce contrôle, chaque clic renverrait la notification à tous.
    h.tricount = tricount([depense("u1", 3000, ["u1", "u2"])], ["u1"]);
    await POST(req(), ctx);
    expect(h.push).not.toHaveBeenCalled();
    expect(h.upsert).toHaveBeenCalledTimes(1); // l'upsert reste idempotent
  });

  it("ne notifie JAMAIS un invité — il n'a pas de compte, donc pas d'abonnement", async () => {
    // Un invité hors asso peut être débiteur. `pushToUser` l'attendrait comme un `User.id` :
    // l'appel partirait dans le vide, et compterait pour une notification envoyée.
    h.tricount = tricount([depense("u1", 3000, ["u1", "g7"])], []);
    await POST(req(), ctx);
    expect(h.push).not.toHaveBeenCalled();
  });

  it("notifie chaque débiteur du montant qu'il doit, et de lui seul", async () => {
    // 60 € payés par u1 pour quatre : u2, u3 et g1 doivent 15 € chacun ; seuls les deux
    // membres sont joignables.
    h.tricount = tricount([depense("u1", 6000, ["u1", "u2", "u3", "g1"])], []);
    await POST(req(), ctx);
    const envois = h.push.mock.calls as unknown as [string, Record<string, string>][];
    expect(envois.map(([u]) => u).sort()).toEqual(["u2", "u3"]);
    for (const [, p] of envois) expect(p.body).toContain("15,00 €");
  });

  it("écrit la validation au nom du membre connecté, sur ce tricount", async () => {
    await POST(req(), ctx);
    expect(h.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tricountId_userId: { tricountId: "t1", userId: "u1" } },
        create: { tricountId: "t1", userId: "u1" },
      }),
    );
  });
});

describe("POST /api/tricount/[id]/approve — défauts épinglés", () => {
  // Ces deux tests FIXENT un comportement que la relecture juge faux, pour qu'une correction
  // se voie. La cause commune : `wasReady`/`nowReady` sont déduits d'une lecture faite AVANT
  // l'écriture, hors transaction. La transition devrait se décider sur le RÉSULTAT de
  // l'écriture (compter les validations après l'upsert, dans la même transaction).

  it("⚠️ un rejeu de la même requête renvoie la notification à tout le monde", async () => {
    // Réponse perdue puis requête rejouée par le client : la base a déjà la validation, mais
    // la seconde exécution relit le même état d'avant et recalcule la même transition.
    h.tricount = tricount([depense("u1", 3000, ["u1", "u2"])], []);
    await POST(req(), ctx);
    await POST(req(), ctx); // même lecture, la validation vient pourtant d'être écrite
    expect(h.push).toHaveBeenCalledTimes(2); // attendu après correction : 1
  });

  it("⚠️ deux payeurs qui valident au même instant ne notifient personne", async () => {
    // Chacun lit `approvals = []` : la transition exige que l'AUTRE y soit déjà, donc les deux
    // répondent « pas encore prêt ». Les deux écritures passent, le tricount devient prêt, et
    // aucun débiteur n'est jamais prévenu.
    const deuxPayeurs = [depense("u1", 3000, ["u1", "u3"]), depense("u2", 3000, ["u2", "u3"])];
    h.tricount = tricount(deuxPayeurs, []);

    h.session = session("u1");
    const a = POST(req(), ctx);
    h.session = session("u2");
    const b = POST(req(), ctx);
    await Promise.all([a, b]);

    expect(h.upsert).toHaveBeenCalledTimes(2); // les deux validations sont bien enregistrées
    expect(h.push).not.toHaveBeenCalled(); // attendu après correction : u3 est prévenu
  });
});
