import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  admin: { userId: "adm", email: "admin@ex.com" } as null | { userId: string; email: string },
  adminEmails: new Set<string>(["admin@ex.com"]),
  featureEmailLogin: true,
  target: null as null | {
    id: string;
    email: string | null;
    displayName: string;
    passwordHash: string | null;
    disabledAt: Date | null;
  },
  featureInterclub: true,
  blockers: { expenses: 0, shares: 0, tournaments: 0, total: 0 },
  members: [{ id: "u1" }] as unknown[],
  teams: [{ id: "t1", name: "Équipe 1" }] as unknown[],
  team: { id: "t1" } as null | { id: string },
  userUpdate: vi.fn(),
  userDelete: vi.fn(),
  sessionDeleteMany: vi.fn(),
  /** Les tricounts dont le membre visé est payeur d'une vraie dépense. */
  payePar: [] as { tricountId: string }[],
  approvalsCreated: vi.fn(),
  passkeyDeleteMany: vi.fn(),
  createEmailToken: vi.fn(),
  alertsChanged: vi.fn(),
}));

vi.mock("@/lib/admin", () => ({
  requireAdmin: vi.fn(async () => h.admin),
  isAdminEmail: (e: string | null | undefined) => (e ? h.adminEmails.has(e) : false),
}));
// Le flag est résolu à chaud côté serveur (env + override en base) : on mocke l'état effectif.
vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({
    tricount: false,
    emailLogin: h.featureEmailLogin,
    directory: false,
    delegation: false,
    tournament: false,
    ranking: false,
    interclub: h.featureInterclub,
  }),
}));
vi.mock("@/lib/members", () => ({
  listMembers: vi.fn(async () => h.members),
  deleteBlockersFor: vi.fn(async () => h.blockers),
}));
vi.mock("@/lib/email-auth", () => ({
  createEmailToken: h.createEmailToken,
  authLinkFor: (_o: string, _p: string, token: string) => `https://x/reinitialiser?token=${token}`,
  clientIp: () => "1.2.3.4",
}));
// La suppression d'un membre emporte ses alertes en cascade et doit donc invalider la porte du
// cron (cf. lib/alerts-gate). `revalidateTag` exige un contexte de requête Next, absent quand on
// appelle le handler directement : on le mocke, et on vérifie l'appel plus bas.
vi.mock("@/lib/alerts-gate", () => ({ alertsChanged: h.alertsChanged }));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => h.target),
      update: h.userUpdate,
      delete: h.userDelete,
    },
    session: { deleteMany: h.sessionDeleteMany },
    // La désactivation est ATOMIQUE : poser `disabledAt`, révoquer les sessions et valider
    // d'office les tricounts dont le membre est payeur vont ensemble. Le mock exécute le
    // corps sur les mêmes doubles, pour que le test voie les trois écritures.
    $transaction: async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        user: { update: h.userUpdate },
        session: { deleteMany: h.sessionDeleteMany },
        expense: { findMany: vi.fn(async () => h.payePar) },
        tricountApproval: { createMany: h.approvalsCreated },
      }),
    passkey: { deleteMany: h.passkeyDeleteMany },
    interclubTeam: {
      findMany: vi.fn(async () => h.teams),
      findUnique: vi.fn(async () => h.team),
    },
  },
}));

import { GET, POST } from "./route";

const req = () => ({ cookies: { get: () => undefined } }) as unknown as NextRequest;
const postReq = (body: unknown) =>
  ({
    cookies: { get: () => undefined },
    json: async () => body,
    nextUrl: { origin: "https://x" },
  }) as unknown as NextRequest;

beforeEach(() => {
  h.admin = { userId: "adm", email: "admin@ex.com" };
  h.adminEmails = new Set(["admin@ex.com"]);
  h.featureEmailLogin = true;
  h.target = {
    id: "u1",
    email: "joueur@ex.com",
    displayName: "Jean Dupont",
    passwordHash: "hash",
    disabledAt: null,
  };
  h.featureInterclub = true;
  h.blockers = { expenses: 0, shares: 0, tournaments: 0, total: 0 };
  h.members = [{ id: "u1" }];
  h.teams = [{ id: "t1", name: "Équipe 1" }];
  h.team = { id: "t1" };
  h.userUpdate.mockReset().mockResolvedValue({});
  h.userDelete.mockReset().mockResolvedValue({});
  h.sessionDeleteMany.mockReset().mockResolvedValue({ count: 0 });
  h.passkeyDeleteMany.mockReset().mockResolvedValue({ count: 2 });
  h.createEmailToken.mockReset().mockResolvedValue("tok123");
});

describe("GET /api/admin/members", () => {
  it("403 si non admin", async () => {
    h.admin = null;
    expect((await GET(req())).status).toBe(403);
  });

  it("renvoie la liste des membres", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).members).toEqual([{ id: "u1" }]);
  });
});

describe("POST /api/admin/members", () => {
  it("403 si non admin", async () => {
    h.admin = null;
    expect((await POST(postReq({ id: "u1", action: "disable" }))).status).toBe(403);
  });

  it("400 si id manquant", async () => {
    expect((await POST(postReq({ action: "disable" }))).status).toBe(400);
  });

  it("404 si membre introuvable", async () => {
    h.target = null;
    expect((await POST(postReq({ id: "zz", action: "disable" }))).status).toBe(404);
  });

  it("400 si on agit sur son propre compte (disable/delete)", async () => {
    h.target = { id: "adm", email: "admin@ex.com", displayName: "Moi", passwordHash: "h", disabledAt: null };
    expect((await POST(postReq({ id: "adm", action: "disable" }))).status).toBe(400);
    expect((await POST(postReq({ id: "adm", action: "delete" }))).status).toBe(400);
    expect(h.userUpdate).not.toHaveBeenCalled();
    expect(h.userDelete).not.toHaveBeenCalled();
  });

  it("400 si la cible est un autre admin (disable/delete)", async () => {
    h.adminEmails = new Set(["admin@ex.com", "joueur@ex.com"]);
    expect((await POST(postReq({ id: "u1", action: "disable" }))).status).toBe(400);
    expect((await POST(postReq({ id: "u1", action: "delete" }))).status).toBe(400);
  });

  it("link : mdp existant → jeton reset + lien", async () => {
    const res = await POST(postReq({ id: "u1", action: "link" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.purpose).toBe("reset");
    expect(body.link).toContain("token=tok123");
    expect(h.createEmailToken).toHaveBeenCalledWith(
      expect.objectContaining({ email: "joueur@ex.com", purpose: "reset", approved: true, displayName: null }),
    );
  });

  it("link : sans mdp → jeton signup (activation) portant le nom", async () => {
    h.target = { id: "u1", email: "joueur@ex.com", displayName: "Jean Dupont", passwordHash: null, disabledAt: null };
    const res = await POST(postReq({ id: "u1", action: "link" }));
    const body = await res.json();
    expect(body.purpose).toBe("signup");
    expect(h.createEmailToken).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "signup", displayName: "Jean Dupont" }),
    );
  });

  it("link : 400 si connexion e-mail désactivée", async () => {
    h.featureEmailLogin = false;
    expect((await POST(postReq({ id: "u1", action: "link" }))).status).toBe(400);
    expect(h.createEmailToken).not.toHaveBeenCalled();
  });

  it("link : 400 si le compte n'a pas d'e-mail", async () => {
    h.target = { id: "u1", email: null, displayName: "X", passwordHash: null, disabledAt: null };
    expect((await POST(postReq({ id: "u1", action: "link" }))).status).toBe(400);
  });

  it("disable : pose disabledAt + révoque les sessions", async () => {
    const res = await POST(postReq({ id: "u1", action: "disable" }));
    expect(res.status).toBe(200);
    expect(h.userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u1" }, data: { disabledAt: expect.any(Date) } }),
    );
    expect(h.sessionDeleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
  });

  it("enable : efface disabledAt", async () => {
    const res = await POST(postReq({ id: "u1", action: "enable" }));
    expect(res.status).toBe(200);
    expect(h.userUpdate).toHaveBeenCalledWith({ where: { id: "u1" }, data: { disabledAt: null } });
  });

  it("revoke_passkeys : supprime tous les passkeys du membre", async () => {
    const res = await POST(postReq({ id: "u1", action: "revoke_passkeys" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: 2 });
    expect(h.passkeyDeleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
  });

  it("revoke_passkey : supprime un passkey précis, borné au membre", async () => {
    h.passkeyDeleteMany.mockResolvedValueOnce({ count: 1 });
    const res = await POST(postReq({ id: "u1", action: "revoke_passkey", passkeyId: "pk1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.passkeyDeleteMany).toHaveBeenCalledWith({ where: { id: "pk1", userId: "u1" } });
  });

  it("revoke_passkey : 400 si passkeyId manquant", async () => {
    const res = await POST(postReq({ id: "u1", action: "revoke_passkey" }));
    expect(res.status).toBe(400);
    expect(h.passkeyDeleteMany).not.toHaveBeenCalled();
  });

  it("revoke_passkey : 404 si le passkey n'appartient pas au membre", async () => {
    h.passkeyDeleteMany.mockResolvedValueOnce({ count: 0 });
    const res = await POST(postReq({ id: "u1", action: "revoke_passkey", passkeyId: "zz" }));
    expect(res.status).toBe(404);
  });

  it("delete : 409 si dépendances bloquantes (ne supprime pas)", async () => {
    h.blockers = { expenses: 2, shares: 5, tournaments: 0, total: 7 };
    const res = await POST(postReq({ id: "u1", action: "delete" }));
    expect(res.status).toBe(409);
    expect((await res.json()).blockers.total).toBe(7);
    expect(h.userDelete).not.toHaveBeenCalled();
  });

  it("delete : supprime si aucune dépendance", async () => {
    const res = await POST(postReq({ id: "u1", action: "delete" }));
    expect(res.status).toBe(200);
    expect(h.userDelete).toHaveBeenCalledWith({ where: { id: "u1" } });
  });

  it("delete : invalide la porte du cron d'alertes (cascade sur SlotAlert)", async () => {
    // C'est le SEUL chemin de disparition d'alertes qui ne passe pas par /api/alerts : la
    // cascade Prisma les emporte silencieusement. Sans invalidation, le cron croirait avoir du
    // travail et réveillerait Neon toutes les 4 minutes jusqu'au TTL (cf. lib/alerts-gate).
    await POST(postReq({ id: "u1", action: "delete" }));
    expect(h.alertsChanged).toHaveBeenCalled();
  });

  it("400 sur action inconnue", async () => {
    expect((await POST(postReq({ id: "u1", action: "frobnicate" }))).status).toBe(400);
  });

  // --- Équipe interclub ----------------------------------------------------
  // L'appartenance à une équipe décide QUI PEUT ÊTRE ALIGNÉ dans une rencontre : c'est donc
  // une décision d'admin, et non un réglage que le membre se donne (elle a un temps vécu dans
  // PATCH /api/profile, où chacun pouvait s'inviter dans une composition).

  it("set_team : rattache un membre à une équipe", async () => {
    const res = await POST(postReq({ id: "u1", action: "set_team", teamId: "t1" }));
    expect(res.status).toBe(200);
    expect(h.userUpdate).toHaveBeenCalledWith({ where: { id: "u1" }, data: { teamId: "t1" } });
  });

  it("set_team : null retire de toute équipe", async () => {
    await POST(postReq({ id: "u1", action: "set_team", teamId: null }));
    expect(h.userUpdate).toHaveBeenCalledWith({ where: { id: "u1" }, data: { teamId: null } });
  });

  // On refuse plutôt qu'on ignore : un écran resté ouvert après la suppression d'une équipe
  // doit l'apprendre, pas croire son geste enregistré.
  it("set_team : refuse une équipe inconnue", async () => {
    h.team = null;
    const res = await POST(postReq({ id: "u1", action: "set_team", teamId: "fantome" }));
    expect(res.status).toBe(400);
    expect(h.userUpdate).not.toHaveBeenCalled();
  });

  it("set_team : 404 si l'interclub est désactivé", async () => {
    h.featureInterclub = false;
    expect((await POST(postReq({ id: "u1", action: "set_team", teamId: "t1" }))).status).toBe(404);
  });

  it("set_team : réservé aux admins, comme le reste de la route", async () => {
    h.admin = null;
    expect((await POST(postReq({ id: "u1", action: "set_team", teamId: "t1" }))).status).toBe(403);
  });

  // --- Correction admin du classement ---------------------------------------
  // Sert quand le rapprochement squashnet a échoué ou s'est trompé (nom mal orthographié côté
  // ResaMania, licence pas encore rapprochée…) : l'ordre des simples interclub (cf.
  // lib/interclub-order.ts) doit pouvoir continuer à s'appliquer malgré l'erreur.

  it("set_clt_override : force le classement, normalisé en MAJUSCULES", async () => {
    const res = await POST(postReq({ id: "u1", action: "set_clt_override", clt: "5b" }));
    expect(res.status).toBe(200);
    expect(h.userUpdate).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { interclubCltOverride: "5B" },
    });
  });

  it("set_clt_override : une chaîne vide retire la correction", async () => {
    await POST(postReq({ id: "u1", action: "set_clt_override", clt: "" }));
    expect(h.userUpdate).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { interclubCltOverride: null },
    });
  });

  it("set_clt_override : refuse un format non reconnu", async () => {
    const res = await POST(postReq({ id: "u1", action: "set_clt_override", clt: "cinq" }));
    expect(res.status).toBe(400);
    expect(h.userUpdate).not.toHaveBeenCalled();
  });

  it("set_clt_override : 404 si l'interclub est désactivé", async () => {
    h.featureInterclub = false;
    expect(
      (await POST(postReq({ id: "u1", action: "set_clt_override", clt: "5A" }))).status,
    ).toBe(404);
  });

  it("set_clt_override : réservé aux admins, comme le reste de la route", async () => {
    h.admin = null;
    expect(
      (await POST(postReq({ id: "u1", action: "set_clt_override", clt: "5A" }))).status,
    ).toBe(403);
  });
});

describe("POST /api/admin/members — désactiver, sans laisser de tricount bloqué", () => {
  beforeEach(() => {
    h.payePar = [];
    // Ce fichier réinitialise ses doubles à la main (pas de `clearAllMocks` global) : sans
    // cette ligne, le second test hériterait de l'appel du premier.
    h.approvalsCreated.mockReset();
  });

  it("VALIDE D'OFFICE les tricounts dont le membre désactivé est payeur", async () => {
    // L'état mort que ça évite : les remboursements n'ouvrent que si TOUS les payeurs ont
    // validé, et seul un payeur peut le faire. Désactiver un compte supprime ses sessions —
    // il ne validera donc jamais, et le tricount reste bloqué à vie : `approve` en 403 pour
    // les autres, `refunds` en 409, et l'unique sortie était d'effacer toute la soirée.
    h.payePar = [{ tricountId: "t1" }, { tricountId: "t2" }];

    const res = await POST(postReq({ id: "u1", action: "disable" }));

    expect(res.status).toBe(200);
    expect(h.userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { disabledAt: expect.any(Date) } }),
    );
    expect(h.sessionDeleteMany).toHaveBeenCalled();
    expect(h.approvalsCreated).toHaveBeenCalledWith({
      data: [
        { tricountId: "t1", userId: "u1" },
        { tricountId: "t2", userId: "u1" },
      ],
      skipDuplicates: true, // rejouable sans créer de doublon
    });
  });

  it("n'écrit aucune validation quand le membre n'est payeur de rien", async () => {
    await POST(postReq({ id: "u1", action: "disable" }));
    expect(h.approvalsCreated).not.toHaveBeenCalled();
  });
});
