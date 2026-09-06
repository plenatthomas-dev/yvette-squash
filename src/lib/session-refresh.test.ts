import { beforeEach, afterEach, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({
  row: { id: "sid", userId: "u1", accessToken: "old", refreshTokenEnc: "refresh-old",
    tokenExpiresAt: new Date(0), refreshClaimedAt: null as Date | null,
    expiresAt: new Date(), identityJson: "{}", user: { displayName: "Alice", email: "a@example.fr", disabledAt: null } },
  refresh: vi.fn(),
}));
vi.mock("./crypto", () => ({ encrypt: (s: string) => s, decrypt: (s: string) => s }));
vi.mock("./resamania/client", () => ({ ensureFresh: h.refresh }));
vi.mock("./db", () => ({ prisma: { session: {
  findUnique: vi.fn(async () => ({ ...h.row })),
  updateMany: vi.fn(async ({ where, data }: {
    where: { refreshClaimedAt?: Date; tokenExpiresAt?: { lte: Date }; OR?: [unknown, { refreshClaimedAt: { lt: Date } }] };
    data: Partial<typeof h.row>;
  }) => {
    if (where.tokenExpiresAt) {
      if (h.row.tokenExpiresAt > where.tokenExpiresAt.lte ||
        (h.row.refreshClaimedAt && h.row.refreshClaimedAt >= where.OR![1].refreshClaimedAt.lt)) return { count: 0 };
    } else if (h.row.refreshClaimedAt?.getTime() !== where.refreshClaimedAt?.getTime()) return { count: 0 };
    Object.assign(h.row, data);
    return { count: 1 };
  }),
  deleteMany: vi.fn(),
} } }));
import { getSession } from "./session";

beforeEach(() => {
  vi.useFakeTimers();
  h.row.accessToken = "old";
  h.row.refreshTokenEnc = "refresh-old";
  h.row.tokenExpiresAt = new Date(Date.now() - 12 * 3600_000);
  h.row.expiresAt = new Date(Date.now() + 86400_000);
  h.row.refreshClaimedAt = null;
  h.refresh.mockReset();
});
afterEach(() => vi.useRealTimers());

it("attend le jeton en cours de rotation au lieu de prêter un jeton expiré", async () => {
  let release!: (value: { accessToken: string; refreshToken: string; expiresAt: number }) => void;
  h.refresh.mockReturnValue(new Promise((resolve) => { release = resolve; }));
  const expiredAt = h.row.tokenExpiresAt.getTime();
  const first = getSession("sid");
  await vi.waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
  let secondResolved = false;
  const second = getSession("sid").then((s) => { secondResolved = true; return s; });
  await vi.advanceTimersByTimeAsync(1000);
  expect(secondResolved).toBe(false);
  expect(h.row.tokenExpiresAt.getTime()).toBe(expiredAt);
  release({ accessToken: "fresh", refreshToken: "refresh-fresh", expiresAt: Date.now() + 3600_000 });
  expect((await first)?.resa?.accessToken).toBe("fresh");
  await vi.advanceTimersByTimeAsync(500);
  expect((await second)?.resa?.accessToken).toBe("fresh");
  expect(h.refresh).toHaveBeenCalledTimes(1);
  expect(h.row.refreshClaimedAt).toBeNull();
});

it("reprend un verrou de rafraîchissement abandonné par un processus mort", async () => {
  h.row.refreshClaimedAt = new Date(Date.now() - 61_000);
  h.refresh.mockResolvedValue({ accessToken: "fresh", refreshToken: "next", expiresAt: Date.now() + 3600_000 });
  expect((await getSession("sid"))?.resa?.accessToken).toBe("fresh");
});
