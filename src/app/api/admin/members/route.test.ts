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
  blockers: { expenses: 0, shares: 0, tournaments: 0, total: 0 },
  members: [{ id: "u1" }] as unknown[],
  userUpdate: vi.fn(),
  userDelete: vi.fn(),
  sessionDeleteMany: vi.fn(),
  createEmailToken: vi.fn(),
}));

vi.mock("@/lib/admin", () => ({
  requireAdmin: vi.fn(async () => h.admin),
  isAdminEmail: (e: string | null | undefined) => (e ? h.adminEmails.has(e) : false),
}));
vi.mock("@/lib/features", () => ({
  get FEATURE_EMAIL_LOGIN() {
    return h.featureEmailLogin;
  },
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
vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => h.target),
      update: h.userUpdate,
      delete: h.userDelete,
    },
    session: { deleteMany: h.sessionDeleteMany },
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
  h.blockers = { expenses: 0, shares: 0, tournaments: 0, total: 0 };
  h.members = [{ id: "u1" }];
  h.userUpdate.mockReset().mockResolvedValue({});
  h.userDelete.mockReset().mockResolvedValue({});
  h.sessionDeleteMany.mockReset().mockResolvedValue({ count: 0 });
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

  it("400 sur action inconnue", async () => {
    expect((await POST(postReq({ id: "u1", action: "frobnicate" }))).status).toBe(400);
  });
});
