import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  requestLogDeleteMany: vi.fn(),
  requestLogCreate: vi.fn(),
  requestLogFindMany: vi.fn(async () => []),
  emailBlockDeleteMany: vi.fn(),
}));

vi.mock("./db", () => ({
  prisma: {
    requestLog: {
      deleteMany: h.requestLogDeleteMany,
      create: h.requestLogCreate,
      findMany: h.requestLogFindMany,
    },
    emailBlock: { deleteMany: h.emailBlockDeleteMany },
  },
}));

import { purgeExpiredModeration, logRequestDecision, listRequestHistory } from "./moderation";
import { MODERATION_RETENTION_MS, MODERATION_RETENTION_LABEL } from "./retention";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** Borne `createdAt: { lt }` passée à un deleteMany. */
const cutoffOf = (mock: { mock: { calls: unknown[][] } }) =>
  (mock.mock.calls[0][0] as { where: { createdAt: { lt: Date } } }).where.createdAt.lt;

describe("purgeExpiredModeration", () => {
  it("purge l'historique ET la blocklist au-delà de la fenêtre", async () => {
    await purgeExpiredModeration();
    expect(h.requestLogDeleteMany).toHaveBeenCalledTimes(1);
    expect(h.emailBlockDeleteMany).toHaveBeenCalledTimes(1);
  });

  it("coupe bien à 12 mois (la durée annoncée aux membres)", async () => {
    // Le test qui compte : si quelqu'un change la durée sans toucher à la note (ou l'inverse),
    // c'est ici que ça doit casser — une note qui promet une durée non tenue est pire que rien.
    vi.setSystemTime(new Date("2026-07-15T12:00:00Z"));
    await purgeExpiredModeration();
    const expected = new Date("2026-07-15T12:00:00Z").getTime() - MODERATION_RETENTION_MS;
    expect(cutoffOf(h.requestLogDeleteMany).getTime()).toBe(expected);
    expect(cutoffOf(h.emailBlockDeleteMany).getTime()).toBe(expected);
    // 365 jours = « 12 mois » : l'étiquette de la note décrit bien la constante.
    expect(MODERATION_RETENTION_MS).toBe(365 * 24 * 60 * 60_000);
    expect(MODERATION_RETENTION_LABEL).toBe("12 mois");
    vi.useRealTimers();
  });

  it("une base en panne ne fait pas échouer l'appelant", async () => {
    h.requestLogDeleteMany.mockRejectedValueOnce(new Error("Neon KO"));
    await expect(purgeExpiredModeration()).resolves.toBeUndefined();
  });
});

describe("déclencheurs de la purge", () => {
  it("journaliser une décision purge d'abord (même si /admin n'est jamais ouvert)", async () => {
    await logRequestDecision({ email: "a@b.fr", purpose: "signup", outcome: "rejected" });
    expect(h.requestLogDeleteMany).toHaveBeenCalledTimes(1);
    expect(h.requestLogCreate).toHaveBeenCalledTimes(1);
  });

  it("lire l'historique purge d'abord (jamais afficher une trace annoncée supprimée)", async () => {
    await listRequestHistory();
    expect(h.requestLogDeleteMany).toHaveBeenCalledTimes(1);
    expect(h.requestLogFindMany).toHaveBeenCalledTimes(1);
  });
});
