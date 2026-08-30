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
// LES VALIDATIONS SONT UN VRAI STOCK ici, pas un tableau figé : la transition se décide
// désormais sur ce que l'écriture a produit, donc un test qui rejouerait toujours le même état
// de départ ne mesurerait plus rien. Deux appels successifs voient bien le résultat du premier.
//
// On utilise le VRAI `computeBalances` et le vrai `payersOf` : ce sont eux qui décident qui est
// débiteur, et une copie dans le test ne prouverait rien sur la route.

const h = vi.hoisted(() => ({
  session: null as null | { userId: string; displayName: string; resa: unknown },
  tricountOn: true,
  tricount: null as null | Record<string, unknown>,
  /** Les validations réellement en base, par membre. */
  approvals: new Set<string>(),
  push: vi.fn(async () => {}),
}));

vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/features-server", () => ({ getFeatures: async () => ({ tricount: h.tricountOn }) }));
vi.mock("@/lib/push", () => ({ pushToUser: h.push }));
vi.mock("@/lib/db", () => ({
  prisma: {
    tricount: { findUnique: vi.fn(async () => h.tricount) },
    // `serializableTransaction` (le vrai) passe par ici : le mock exécute le corps sur le
    // stock ci-dessus, donc deux appels successifs se voient l'un l'autre.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        tricountApproval: {
          findUnique: async (a: { where: { tricountId_userId: { userId: string } } }) =>
            h.approvals.has(a.where.tricountId_userId.userId)
              ? { userId: a.where.tricountId_userId.userId }
              : null,
          upsert: async (a: { create: { userId: string } }) => {
            h.approvals.add(a.create.userId);
            return a.create;
          },
          findMany: async () => [...h.approvals].map((userId) => ({ userId })),
        },
      }),
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

/** Le tricount du 3 septembre, avec ses dépenses. Les validations vivent dans `h.approvals`. */
function tricount(expenses: unknown[], approvals: string[] = []) {
  h.approvals = new Set(approvals);
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
  h.tricount = tricount([depense("u1", 3000, ["u1", "u2"])]);
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
    expect(h.approvals.size).toBe(0);
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

  it("demande à être ENTENDUE : `renotify` sur un tag partagé", async () => {
    // Le tag regroupe les annonces d'un même tricount pour n'empiler qu'une ligne sur l'écran
    // verrouillé. Sans `renotify`, la spec impose un remplacement SILENCIEUX : un tricount
    // rouvert après correction porte un montant différent, et le débiteur ne l'apprendrait pas.
    await POST(req(), ctx);
    const [, payload] = h.push.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(payload.tag).toBe("tricount-ready-t1");
    expect(payload.renotify).toBe(true);
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
    h.tricount = tricount([
      depense("u1", 3000, ["u1", "u2", "u3"]),
      depense("u2", 3000, ["u1", "u2", "u3"]),
    ]);
    await POST(req(), ctx); // u1 valide, u2 manque encore
    expect(h.approvals.has("u1")).toBe(true);
    expect(h.push).not.toHaveBeenCalled();
  });

  it("ne notifie PAS une seconde fois quand tout le monde avait déjà validé", async () => {
    // Revalider un tricount déjà prêt est sans effet visible : c'est ce qui rend le bouton
    // sûr à re-cliquer. Sans ce contrôle, chaque clic renverrait la notification à tous.
    h.tricount = tricount([depense("u1", 3000, ["u1", "u2"])], ["u1"]);
    await POST(req(), ctx);
    expect(h.push).not.toHaveBeenCalled();
  });

  it("ne notifie JAMAIS un invité — il n'a pas de compte, donc pas d'abonnement", async () => {
    // Un invité hors asso peut être débiteur. `pushToUser` l'attendrait comme un `User.id` :
    // l'appel partirait dans le vide, et compterait pour une notification envoyée.
    h.tricount = tricount([depense("u1", 3000, ["u1", "g7"])]);
    await POST(req(), ctx);
    expect(h.push).not.toHaveBeenCalled();
  });

  it("notifie chaque débiteur du montant qu'il doit, et de lui seul", async () => {
    // 60 € payés par u1 pour quatre : u2, u3 et g1 doivent 15 € chacun ; seuls les deux
    // membres sont joignables.
    h.tricount = tricount([depense("u1", 6000, ["u1", "u2", "u3", "g1"])]);
    await POST(req(), ctx);
    const envois = h.push.mock.calls as unknown as [string, Record<string, string>][];
    expect(envois.map(([u]) => u).sort()).toEqual(["u2", "u3"]);
    for (const [, p] of envois) expect(p.body).toContain("15,00 €");
  });

  it("écrit la validation au nom du membre connecté", async () => {
    await POST(req(), ctx);
    expect([...h.approvals]).toEqual(["u1"]);
  });
});

describe("POST /api/tricount/[id]/approve — ce que la transition ne fait plus", () => {
  // Ces deux cas fixaient auparavant un DÉFAUT : la transition se déduisait d'une lecture
  // faite avant l'écriture, hors transaction. Elle se décide maintenant sur le résultat de
  // l'écriture, dans une transaction Serializable.

  it("un REJEU de la même requête ne renvoie pas la notification", async () => {
    // Réponse perdue puis requête rejouée par le client : la validation est déjà en base, ce
    // clic n'ouvre donc rien. Avant, la seconde exécution relisait le même état d'avant et
    // réannonçait l'ouverture à tous les débiteurs.
    h.tricount = tricount([depense("u1", 3000, ["u1", "u2"])]);
    await POST(req(), ctx);
    await POST(req(), ctx);
    expect(h.push).toHaveBeenCalledTimes(1);
  });

  it("deux payeurs qui valident coup sur coup : UNE annonce, et elle part bien", async () => {
    // Avant, chacun lisait « aucune validation » et concluait « pas encore prêt » : les deux
    // écritures passaient, le tricount devenait prêt, et personne n'était jamais prévenu.
    // Le second entrant voit désormais la validation du premier et annonce.
    //
    // (La vraie simultanéité — deux transactions ouvertes en même temps, chacune aveugle à
    // l'autre — se mesure sur une vraie base : cf. `tricount-approve.pg.test.ts`.)
    h.tricount = tricount([depense("u1", 3000, ["u1", "u3"]), depense("u2", 3000, ["u2", "u3"])]);

    h.session = session("u1");
    await POST(req(), ctx);
    h.session = session("u2");
    await POST(req(), ctx);

    expect([...h.approvals].sort()).toEqual(["u1", "u2"]);
    expect(h.push).toHaveBeenCalledTimes(1);
    expect((h.push.mock.calls[0] as unknown as [string])[0]).toBe("u3");
  });
});
