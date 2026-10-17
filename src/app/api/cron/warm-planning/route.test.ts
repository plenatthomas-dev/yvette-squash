import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { NextRequest } from "next/server";
import { ResaAuthRejectedError, ResaUnavailableError } from "@/lib/resamania/errors";

// PRÉCHAUFFAGE DU PLANNING — le heartbeat dit POURQUOI il n'a pas eu lieu.
//
// Ce cron se connecte avec un compte de service (`login`), jamais via les sessions des membres :
// `ResaRefreshTransientError` ne le concerne pas, et son `login` était déjà sous try/catch. Les
// erreurs typées permettent seulement de distinguer, au tableau de bord, une panne passagère
// (« ça reviendra ») d'identifiants refusés (« ça ne se réparera pas tout seul »).

const h = vi.hoisted(() => ({
  login: vi.fn(),
  getPlanning: vi.fn(),
  recordCronRun: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    planningSnapshot: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      upsert: vi.fn(),
    },
  },
}));
vi.mock("@/lib/resamania/client", () => ({ login: h.login, getPlanning: h.getPlanning }));
vi.mock("@/lib/cron-auth", () => ({ cronAuthorized: () => true }));
vi.mock("@/lib/cron-run", () => ({ recordCronRun: h.recordCronRun }));

import { GET } from "./route";

const req = () => ({}) as NextRequest;

beforeEach(() => {
  vi.stubEnv("RESA_CRON_USER", "service");
  vi.stubEnv("RESA_CRON_PASSWORD", "secret");
  h.login.mockReset();
  h.getPlanning.mockReset().mockResolvedValue({ slots: [] });
  h.recordCronRun.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/cron/warm-planning — raison de l'échec du compte de service", () => {
  it("ResaMania en panne → « indisponible, reporté », sans exception", async () => {
    h.login.mockImplementation(() => Promise.reject(new ResaUnavailableError("down", 503)));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(h.recordCronRun).toHaveBeenCalledWith(
      "warm-planning",
      false,
      "ResaMania indisponible, reporté au prochain passage",
    );
    expect(h.getPlanning).not.toHaveBeenCalled();
  });

  it("identifiants refusés → le heartbeat le dit (à corriger à la main)", async () => {
    h.login.mockImplementation(() => Promise.reject(new ResaAuthRejectedError("refus")));
    await GET(req());
    expect(h.recordCronRun).toHaveBeenCalledWith(
      "warm-planning",
      false,
      "compte de service ResaMania : identifiants refusés",
    );
  });

  it("compte non configuré → raison explicite, aucune tentative de connexion", async () => {
    vi.stubEnv("RESA_CRON_PASSWORD", "");
    await GET(req());
    expect(h.login).not.toHaveBeenCalled();
    expect(h.recordCronRun).toHaveBeenCalledWith(
      "warm-planning",
      false,
      "compte de service ResaMania non configuré",
    );
  });

  it("connexion réussie → préchauffe les 16 jours", async () => {
    h.login.mockResolvedValue({ accessToken: "tok" });
    const res = await GET(req());
    expect(await res.json()).toMatchObject({ warmed: 16, total: 16 });
    expect(h.getPlanning).toHaveBeenCalledWith(expect.any(String), "tok");
  });
});
