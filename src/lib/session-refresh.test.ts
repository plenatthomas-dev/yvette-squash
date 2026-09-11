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
import { getSession, refreshBackoffMs } from "./session";

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
  // 2 s, et non 500 ms : l'attente suit `refreshBackoffMs` (250 → 500 → 1 s → plateau à 2 s),
  // donc ce dernier bond doit couvrir le plus long des délais possibles. Une valeur plus
  // courte ne prouverait que la cadence du début de boucle.
  await vi.advanceTimersByTimeAsync(2000);
  expect((await second)?.resa?.accessToken).toBe("fresh");
  expect(h.refresh).toHaveBeenCalledTimes(1);
  expect(h.row.refreshClaimedAt).toBeNull();
});

it("reprend un verrou de rafraîchissement abandonné par un processus mort", async () => {
  h.row.refreshClaimedAt = new Date(Date.now() - 61_000);
  h.refresh.mockResolvedValue({ accessToken: "fresh", refreshToken: "next", expiresAt: Date.now() + 3600_000 });
  expect((await getSession("sid"))?.resa?.accessToken).toBe("fresh");
});

it("espace les relectures au lieu de marteler la base toutes les 250 ms", () => {
  // À cadence fixe, les 20 s d'attente coûtaient jusqu'à 80 lectures à UNE requête, toutes
  // pour la même réponse. Vérifié sur la fonction PURE : prouver une progression
  // arithmétique n'a pas à coûter vingt secondes de harnais.
  expect([0, 1, 2, 3, 4, 10].map(refreshBackoffMs)).toEqual([250, 500, 1000, 2000, 2000, 2000]);

  // Le cas NORMAL — une ou deux relectures — n'est pas ralenti : c'est la condition pour que
  // l'économie ne se paie pas en latence ressentie.
  expect(refreshBackoffMs(0)).toBe(250);

  // Ce qui compte vraiment : le nombre de lectures tenues dans la fenêtre d'attente.
  let t = 0;
  let lectures = 0;
  while (t < 20_000) { t += refreshBackoffMs(lectures); lectures++; }
  expect(lectures).toBeLessThan(15); // était 80
});
