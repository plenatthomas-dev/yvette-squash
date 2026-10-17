import { beforeEach, afterEach, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({
  row: { id: "sid", userId: "u1", accessToken: "old", refreshTokenEnc: "refresh-old",
    tokenExpiresAt: new Date(0), refreshClaimedAt: null as Date | null,
    expiresAt: new Date(), identityJson: "{}", user: { displayName: "Alice", email: "a@example.fr", disabledAt: null } },
  refresh: vi.fn(),
}));
vi.mock("./crypto", () => ({ encrypt: (s: string) => s, decrypt: (s: string) => s }));
// Les erreurs typées et leurs gardes sont les VRAIES : c'est leur classement que session.ts
// consulte pour décider de supprimer (refus) ou de garder (panne passagère) la session.
vi.mock("./resamania/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./resamania/client")>()),
  ensureFresh: h.refresh,
}));
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
import { getSession, refreshBackoffMs, ResaRefreshTransientError } from "./session";
import { prisma } from "./db";
import { ResaAuthRejectedError, ResaUnavailableError } from "./resamania/client";

beforeEach(() => {
  vi.useFakeTimers();
  h.row.accessToken = "old";
  h.row.refreshTokenEnc = "refresh-old";
  h.row.tokenExpiresAt = new Date(Date.now() - 12 * 3600_000);
  h.row.expiresAt = new Date(Date.now() + 86400_000);
  h.row.refreshClaimedAt = null;
  h.refresh.mockReset();
  vi.mocked(prisma.session.deleteMany).mockClear();
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

// PANNE PASSAGÈRE ≠ JETON RÉVOQUÉ. Avant, toute erreur du rafraîchissement supprimait la
// session : un 503 de quelques secondes chez ResaMania déconnectait chaque membre dont le jeton
// expirait pendant ce temps (et cassait les délégations, qui vivent de ce même jeton).

it("ResaMania en 503 au rafraîchissement : session CONSERVÉE, verrou relâché, erreur passagère", async () => {
  // Rejet construit à l'appel (et non `mockRejectedValue`) : vitest remonte comme échec du test
  // une exception levée par un espion, même attrapée par le code testé.
  h.refresh.mockImplementation(() =>
    Promise.reject(new ResaUnavailableError("Échange de token : ResaMania indisponible (503)", 503)),
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});

  const err = await getSession("sid").catch((e) => e);

  expect(err).toBeInstanceOf(ResaRefreshTransientError);
  expect(prisma.session.deleteMany).not.toHaveBeenCalled();
  // Verrou rendu tout de suite : la requête suivante retente sans attendre la reprise d'un
  // verrou abandonné (60 s)…
  expect(h.row.refreshClaimedAt).toBeNull();
  // …et les jetons sont intacts : rien n'a été écrasé par une réponse qui n'est jamais venue.
  expect(h.row.refreshTokenEnc).toBe("refresh-old");

  // La panne passée, la session repart d'elle-même.
  h.refresh.mockResolvedValue({ accessToken: "fresh", refreshToken: "next", expiresAt: Date.now() + 3600_000 });
  expect((await getSession("sid"))?.resa?.accessToken).toBe("fresh");
});

it("refresh token refusé (400 invalid_grant) : session supprimée, reconnexion requise", async () => {
  h.refresh.mockImplementation(() =>
    Promise.reject(new ResaAuthRejectedError("Échange de token refusé (400 invalid_grant)")),
  );

  expect(await getSession("sid")).toBeNull();
  // Suppression sous le MÊME filtre de verrou : on ne détruit que la ligne qu'on a réservée.
  expect(prisma.session.deleteMany).toHaveBeenCalledWith({
    where: { id: "sid", refreshClaimedAt: expect.any(Date) },
  });
});
