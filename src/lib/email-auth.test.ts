import { beforeEach, afterEach, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({
  attempts: [] as { email: string; ip: string; createdAt: Date }[],
  tokens: [] as { email: string; purpose: string; approvedAt: Date | null; expiresAt: Date }[],
}));
vi.mock("./crypto", () => ({ hashToken: (s: string) => s }));
vi.mock("./email", () => ({ sendEmail: vi.fn() }));
vi.mock("./moderation", () => ({ logRequestDecision: vi.fn() }));
vi.mock("./db", () => {
  const db = {
    emailRequestAttempt: {
      deleteMany: async ({ where }: { where: { createdAt: { lt: Date } } }) => {
        h.attempts = h.attempts.filter((r) => r.createdAt >= where.createdAt.lt);
      },
      count: async ({ where }: { where: { email?: string; ip?: string; createdAt: { gte: Date } } }) =>
        h.attempts.filter((r) => r.createdAt >= where.createdAt.gte && (!where.email || r.email === where.email) && (!where.ip || r.ip === where.ip)).length,
      create: async ({ data }: { data: { email: string; ip: string } }) => { h.attempts.push({ ...data, createdAt: new Date() }); },
    },
    emailToken: {
      count: async () => h.tokens.filter((r) => !r.approvedAt).length,
      deleteMany: async ({ where }: { where: { email?: string; purpose?: string; expiresAt?: { lt: Date } } }) => {
        h.tokens = h.tokens.filter((r) => where.expiresAt ? r.expiresAt >= where.expiresAt.lt : r.email !== where.email || r.purpose !== where.purpose || r.approvedAt);
      },
      create: async ({ data }: { data: typeof h.tokens[number] }) => { h.tokens.push(data); },
    },
  };
  return { prisma: { ...db, $transaction: async (run: (tx: typeof db) => Promise<unknown>) => run(db) } };
});
import { emailSendRateLimited, createEmailToken } from "./email-auth";

beforeEach(() => { vi.useFakeTimers(); h.attempts = []; h.tokens = []; });
afterEach(() => vi.useRealTimers());
it("compte les demandes répétées, alors que chaque jeton en attente remplace le précédent", async () => {
  let accepted = 0;
  for (let i = 0; i < 20; i++) {
    if (await emailSendRateLimited("a@example.fr", "ip")) continue;
    accepted++;
    await createEmailToken({ email: "a@example.fr", purpose: "reset", ip: "ip" });
  }
  expect(accepted).toBe(3);
  expect(h.tokens).toHaveLength(1);
  expect(h.attempts).toHaveLength(3);
  h.tokens = []; // Consommer ou supprimer un lien n'efface pas l'historique des demandes.
  expect(await emailSendRateLimited("a@example.fr", "another-ip")).toBe(true);
});
it("plafonne une IP sur plusieurs adresses, et rouvre la fenêtre au bout de dix minutes", async () => {
  for (let i = 0; i < 5; i++) expect(await emailSendRateLimited(`${i}@example.fr`, "ip")).toBe(false);
  expect(await emailSendRateLimited("six@example.fr", "ip")).toBe(true);
  await vi.advanceTimersByTimeAsync(600_001);
  expect(await emailSendRateLimited("six@example.fr", "ip")).toBe(false);
  expect(h.attempts).toHaveLength(1);
});
