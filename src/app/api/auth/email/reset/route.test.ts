import { beforeEach, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
const h = vi.hoisted(() => ({
  disabledAt: null as Date | null, tokenCount: 1,
  userUpdate: vi.fn(), sessionDelete: vi.fn(), sessionCreate: vi.fn(),
  tokenDelete: vi.fn(), transaction: vi.fn(),
}));
vi.mock("@/lib/features-server", () => ({ getFeatures: async () => ({ emailLogin: true }) }));
vi.mock("@/lib/crypto", () => ({ hashPassword: async () => "new-hash", encrypt: (s: string) => s, decrypt: (s: string) => s }));
vi.mock("@/lib/resamania/client", () => ({ ensureFresh: vi.fn() }));
vi.mock("@/lib/app-block", () => ({ appBlockForEmail: async () => null }));
vi.mock("@/lib/email-auth", () => ({
  passwordProblem: () => null,
  findApprovedToken: async () => ({ id: "link", tokenHash: "hash", email: "a@example.fr", purpose: "reset" }),
  nameFromEmail: () => "Alice",
}));
vi.mock("@/lib/db", () => ({ prisma: { $transaction: h.transaction } }));
import { POST } from "./route";
const req = () => new NextRequest("http://localhost/api/auth/email/reset", {
  method: "POST", body: JSON.stringify({ token: "approved-link", password: "new-password" }),
});
beforeEach(() => {
  vi.clearAllMocks(); h.disabledAt = null; h.tokenCount = 1;
  h.userUpdate.mockResolvedValue({ id: "u1", displayName: "Alice" });
  h.tokenDelete.mockImplementation(async () => ({ count: h.tokenCount }));
  h.transaction.mockImplementation(async (run) => run({
    user: { findUnique: async () => ({ id: "u1", displayName: "Alice", disabledAt: h.disabledAt }), update: h.userUpdate },
    emailToken: { deleteMany: h.tokenDelete },
    session: { deleteMany: h.sessionDelete, create: h.sessionCreate },
  }));
});
it("refuse un compte désactivé sans consommer son lien ni changer son mot de passe", async () => {
  h.disabledAt = new Date();
  expect((await POST(req())).status).toBe(403);
  expect(h.userUpdate).not.toHaveBeenCalled();
  expect(h.tokenDelete).not.toHaveBeenCalled();
  expect(h.sessionCreate).not.toHaveBeenCalled();
});
it("révoque anciennes sessions et liens avant de créer l'unique nouvelle, dans la transaction", async () => {
  const response = await POST(req());
  expect(response.status).toBe(200);
  expect(response.cookies.get("sid")?.value).toBeTruthy();
  expect(h.sessionDelete).toHaveBeenCalledWith({ where: { userId: "u1" } });
  expect(h.tokenDelete).toHaveBeenCalledWith({ where: { email: "a@example.fr" } });
  expect(h.userUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ passwordHash: "new-hash" }) }));
  expect(h.sessionCreate).toHaveBeenCalledTimes(1);
  expect(h.sessionDelete.mock.invocationCallOrder[0]).toBeLessThan(h.sessionCreate.mock.invocationCallOrder[0]);
  expect(h.transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: "Serializable" }));
});
it("refuse un lien consommé entre la lecture initiale et la transaction", async () => {
  h.tokenCount = 0;
  expect((await POST(req())).status).toBe(400);
  expect(h.userUpdate).not.toHaveBeenCalled();
  expect(h.sessionCreate).not.toHaveBeenCalled();
});
