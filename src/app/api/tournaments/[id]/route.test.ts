import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  featureOn: true,
  session: null as null | { userId: string },
  tournament: null as null | Record<string, unknown>,
  view: { status: "running" } as { status: string },
  updateSpy: vi.fn(async () => ({})),
  deleteSpy: vi.fn(async () => ({})),
}));

vi.mock("@/lib/features", () => ({
  get FEATURE_TOURNAMENT() {
    return h.featureOn;
  },
}));
vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    tournament: {
      findUnique: vi.fn(async () => h.tournament),
      update: h.updateSpy,
      delete: h.deleteSpy,
    },
  },
}));
// serializeTournament est testé ailleurs (tournament-db.test) → ici on le contrôle.
vi.mock("@/lib/tournament-db", () => ({
  tournamentInclude: {},
  serializeTournament: () => h.view,
}));

import { GET, DELETE } from "./route";

const req = () => ({ cookies: { get: () => undefined } }) as unknown as NextRequest;
const params = Promise.resolve({ id: "t1" });

beforeEach(() => {
  h.featureOn = true;
  h.session = { userId: "u1" };
  h.tournament = null;
  h.view = { status: "running" };
  h.updateSpy.mockClear();
  h.deleteSpy.mockClear();
});

describe("GET /api/tournaments/[id]", () => {
  it("404 si la fonction est désactivée", async () => {
    h.featureOn = false;
    expect((await GET(req(), { params })).status).toBe(404);
  });
  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await GET(req(), { params })).status).toBe(401);
  });
  it("404 si le tournoi est introuvable", async () => {
    h.tournament = null;
    expect((await GET(req(), { params })).status).toBe(404);
  });
  it("auto-cicatrise le statut si terminé mais encore 'running' en base", async () => {
    h.tournament = { status: "running" };
    h.view = { status: "done" };
    const res = await GET(req(), { params });
    expect(res.status).toBe(200);
    expect(h.updateSpy).toHaveBeenCalledWith({ where: { id: "t1" }, data: { status: "done" } });
  });
  it("ne réécrit pas le statut si le tournoi n'est pas terminé", async () => {
    h.tournament = { status: "running" };
    h.view = { status: "running" };
    await GET(req(), { params });
    expect(h.updateSpy).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/tournaments/[id]", () => {
  it("404 si la fonction est désactivée", async () => {
    h.featureOn = false;
    expect((await DELETE(req(), { params })).status).toBe(404);
  });
  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await DELETE(req(), { params })).status).toBe(401);
  });
  it("404 si le tournoi est introuvable", async () => {
    h.tournament = null;
    expect((await DELETE(req(), { params })).status).toBe(404);
  });
  it("403 si l'utilisateur n'est pas le créateur (et ne supprime rien)", async () => {
    h.tournament = { createdById: "autre" };
    const res = await DELETE(req(), { params });
    expect(res.status).toBe(403);
    expect(h.deleteSpy).not.toHaveBeenCalled();
  });
  it("supprime si l'utilisateur est le créateur", async () => {
    h.tournament = { createdById: "u1" };
    const res = await DELETE(req(), { params });
    expect(res.status).toBe(200);
    expect(h.deleteSpy).toHaveBeenCalledWith({ where: { id: "t1" } });
  });
});
