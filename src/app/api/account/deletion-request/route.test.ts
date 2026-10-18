import { beforeEach, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

// La demande de suppression de compte : ce qu'elle doit garantir, c'est qu'une demande partie
// arrive avec ce dont l'administrateur a besoin pour agir — qui, comment lui répondre, et si un
// historique bloque la suppression — et qu'elle ne parte pas pour quelqu'un qui n'est personne.

const h = vi.hoisted(() => ({
  session: null as null | { userId: string; displayName: string; resa?: { identity: { email?: string } } },
  recently: 0,
  configured: true,
  blockers: { expenses: 0, shares: 0, tournaments: 0, total: 0 },
  sendEmail: vi.fn(),
  record: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSession: async () => h.session }));
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: async () => ({ email: "compte@example.fr" }) } },
}));
vi.mock("@/lib/email", () => ({ sendEmail: h.sendEmail, emailConfigured: () => h.configured }));
vi.mock("@/lib/members", () => ({ deleteBlockersFor: async () => h.blockers }));
vi.mock("@/lib/owner-inbox", () => ({
  OWNER_INBOX: "proprio@example.fr",
  OWNER_MAX_PER_DAY: 10,
  ownerMessagesRecently: async () => h.recently,
  recordOwnerMessage: h.record,
}));

import { POST } from "./route";

const req = () =>
  new NextRequest("http://localhost/api/account/deletion-request", { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
  h.session = { userId: "u1", displayName: "Alice Martin" };
  h.recently = 0;
  h.configured = true;
  h.blockers = { expenses: 0, shares: 0, tournaments: 0, total: 0 };
  h.sendEmail.mockResolvedValue(undefined);
});

it("refuse sans session, sans rien envoyer", async () => {
  h.session = null;
  expect((await POST(req())).status).toBe(401);
  expect(h.sendEmail).not.toHaveBeenCalled();
});

it("envoie la demande au propriétaire, avec l'adresse du membre pour lui répondre", async () => {
  const res = await POST(req());
  expect(res.status).toBe(200);
  const mail = h.sendEmail.mock.calls[0][0];
  expect(mail.to).toBe("proprio@example.fr");
  expect(mail.replyTo).toBe("compte@example.fr");
  expect(mail.subject).toMatch(/suppression de compte/i);
  expect(mail.text).toMatch(/Alice Martin/);
  expect(mail.text).toMatch(/u1/);
  expect(mail.text).toMatch(/Rien ne bloque/);
  expect(h.record).toHaveBeenCalledWith("u1");
});

it("préfère l'adresse ResaMania quand la session en a une", async () => {
  h.session = { userId: "u1", displayName: "Alice", resa: { identity: { email: " resa@example.fr " } } };
  await POST(req());
  expect(h.sendEmail.mock.calls[0][0].replyTo).toBe("resa@example.fr");
});

it("prévient l'administrateur quand un historique bloque la suppression", async () => {
  // Sans ce signal, il découvrirait le blocage en cliquant « Supprimer » — après avoir peut-être
  // déjà répondu au membre que c'était fait.
  h.blockers = { expenses: 2, shares: 1, tournaments: 0, total: 3 };
  await POST(req());
  const text = h.sendEmail.mock.calls[0][0].text;
  expect(text).toMatch(/BLOQUÉE/);
  expect(text).toMatch(/2 dépense/);
  expect(text).toMatch(/désactiver le compte/i);
});

it("partage le quota de la boîte du propriétaire", async () => {
  h.recently = 10;
  expect((await POST(req())).status).toBe(429);
  expect(h.sendEmail).not.toHaveBeenCalled();
});

it("dit clairement quand l'e-mail n'est pas configuré", async () => {
  h.configured = false;
  expect((await POST(req())).status).toBe(503);
});

it("ne compte pas un envoi échoué", async () => {
  h.sendEmail.mockRejectedValue(new Error("smtp"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect((await POST(req())).status).toBe(502);
  expect(h.record).not.toHaveBeenCalled();
});
