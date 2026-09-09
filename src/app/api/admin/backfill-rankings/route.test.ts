import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";
import type { BackfillResult } from "@/lib/squashnet/backfill";

const h = vi.hoisted(() => ({
  admin: { userId: "adm", email: "admin@ex.com" } as null | { userId: string; email: string },
  featureRanking: true,
  result: {} as BackfillResult,
  backfillHistory: vi.fn(),
  recordCronRun: vi.fn(),
}));

vi.mock("@/lib/admin", () => ({ requireAdmin: vi.fn(async () => h.admin) }));
vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({
    tricount: false,
    emailLogin: false,
    biometry: false,
    directory: false,
    delegation: false,
    tournament: false,
    ranking: h.featureRanking,
  }),
}));
// On stub SEULEMENT le remplissage ; `MOIS_PAR_DEFAUT` reste la vraie constante, pour que le
// test casse si la profondeur change sans que l'écran le dise.
vi.mock("@/lib/squashnet/backfill", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/squashnet/backfill")>()),
  backfillHistory: h.backfillHistory,
}));
vi.mock("@/lib/cron-run", () => ({ recordCronRun: h.recordCronRun }));

import { POST } from "./route";

const req = () => ({ cookies: { get: () => undefined } }) as unknown as NextRequest;

/** Un compte-rendu de remplissage, complet par défaut. */
function resultat(over: Partial<BackfillResult> = {}): BackfillResult {
  return {
    months: ["2026-03-02", "2026-02-02"],
    subjects: 4,
    requests: 8,
    written: 8,
    already: 0,
    unresolved: 0,
    failed: 0,
    remaining: 0,
    stopped: false,
    ...over,
  };
}

beforeEach(() => {
  h.admin = { userId: "adm", email: "admin@ex.com" };
  h.featureRanking = true;
  h.result = resultat();
  h.backfillHistory.mockReset().mockImplementation(async () => h.result);
  h.recordCronRun.mockReset().mockResolvedValue(undefined);
});

describe("POST /api/admin/backfill-rankings", () => {
  it("403 pour un non-admin, sans toucher à squashnet", async () => {
    h.admin = null;
    expect((await POST(req())).status).toBe(403);
    expect(h.backfillHistory).not.toHaveBeenCalled();
  });

  it("404 si la fonction classement est coupée", async () => {
    h.featureRanking = false;
    expect((await POST(req())).status).toBe(404);
    expect(h.backfillHistory).not.toHaveBeenCalled();
  });

  // Le budget est ce qui distingue cette route du script : une fonction Vercel tuée en vol ne
  // rend aucun compte-rendu, donc l'admin ne saurait ni ce qui a été fait ni s'il doit recliquer.
  it("borne le travail dans le temps, sous la coupe de Vercel", async () => {
    await POST(req());
    const opts = h.backfillHistory.mock.calls[0][0] as { budgetMs: number; delayMs: number };
    expect(opts.budgetMs).toBeGreaterThan(0);
    expect(opts.budgetMs).toBeLessThan(60_000);
    expect(opts.delayMs).toBeGreaterThan(0); // on n'inonde jamais squashnet, même pressé
  });

  it("502 si squashnet ne publie aucune période", async () => {
    h.result = resultat({ months: [], written: 0, requests: 0 });
    expect((await POST(req())).status).toBe(502);
  });

  it("rend le compte-rendu, dont ce qu'il RESTE à faire", async () => {
    h.result = resultat({ written: 40, remaining: 120, stopped: true, unresolved: 3 });
    const body = await (await POST(req())).json();
    expect(body).toMatchObject({ ok: true, written: 40, remaining: 120, stopped: true, unresolved: 3 });
  });

  it("un run qui n'avait rien à faire va bien (et ne fait aucune requête)", async () => {
    h.result = resultat({ written: 0, already: 96, requests: 0 });
    const body = await (await POST(req())).json();
    expect(body.ok).toBe(true);
  });

  it("une panne base rend le run en échec", async () => {
    h.result = resultat({ written: 2, failed: 1 });
    const body = await (await POST(req())).json();
    expect(body.ok).toBe(false);
  });

  // Tout tenté, rien obtenu, alors que squashnet a bien été interrogé : c'est un site muet ou
  // un rapprochement cassé, pas un succès. Le taire ferait afficher un ✓ vert sur une panne.
  it("squashnet muet (rien de concluant sur tout ce qui a été demandé) → échec", async () => {
    h.result = resultat({ written: 0, unresolved: 8, requests: 8 });
    const body = await (await POST(req())).json();
    expect(body.ok).toBe(false);
  });

  it("horodate sous une clé À LUI, pour ne pas masquer la panne d'un autre travail", async () => {
    await POST(req());
    expect(h.recordCronRun).toHaveBeenCalledWith(
      "rankings-historique-manuel",
      true,
      expect.stringContaining("restant"),
    );
  });
});
