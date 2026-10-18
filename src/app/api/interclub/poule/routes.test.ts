import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextRequest } from "next/server";

// ============================================================================
//  LES FICHES D'ÉQUIPE ET DE JOUEUR — deux routes ouvertes à tout membre, qui
//  peuvent sortir chez la fédération avec un identifiant reçu du CLIENT.
//
//  Ce qu'on tient ici, sur les vrais fragments du 2026-10-18 et une base en
//  mémoire : un identifiant absent de nos poules rend 404 SANS requête ; `GET`
//  ne sort jamais ; `POST` ne relit que ce qui a vieilli, et ne retourne pas
//  marteler une poule qui vient d'échouer.
// ============================================================================

const fixture = (f: string) =>
  readFileSync(join(process.cwd(), "src/lib/squashnet/__fixtures__", f), "utf8");

const h = vi.hoisted(() => ({
  access: true,
  team: null as null | Record<string, unknown>,
  pools: new Map<string, { snRoundId: string; tiesJson: string; fetchedAt: Date }>(),
  rosters: new Map<string, { snTeamId: string; rosterJson: string; fetchedAt: Date }>(),
  players: new Map<string, { regiid: string; json: string; fetchedAt: Date }>(),
  fetchPool: vi.fn(),
  fetchRoster: vi.fn(),
  fetchPlayer: vi.fn(),
}));

vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => fn, revalidateTag: vi.fn() }));
vi.mock("@/lib/interclub-access", () => ({
  requireInterclubMember: vi.fn(async () =>
    h.access
      ? { ok: true, session: { userId: "u1" } }
      : { ok: false, response: new Response(null, { status: 401 }) },
  ),
}));

const contient = (json: string | undefined, where?: { contains?: string }) =>
  !where?.contains || (json ?? "").includes(where.contains);

vi.mock("@/lib/db", () => ({
  prisma: {
    interclubTeam: {
      findMany: vi.fn(async () => (h.team ? [h.team] : [])),
      findUnique: vi.fn(async () => h.team),
      update: vi.fn(async (a: { data: Record<string, unknown> }) => {
        Object.assign(h.team ?? {}, a.data);
        return h.team;
      }),
    },
    squashnetPool: {
      findUnique: vi.fn(async (a: { where: { snRoundId: string } }) => h.pools.get(a.where.snRoundId) ?? null),
      upsert: vi.fn(async (a: { where: { snRoundId: string }; create: { tiesJson: string; fetchedAt: Date } }) => {
        h.pools.set(a.where.snRoundId, { snRoundId: a.where.snRoundId, ...a.create });
      }),
      count: vi.fn(async (a: { where: { tiesJson?: { contains?: string } } }) =>
        [...h.pools.values()].filter((p) => contient(p.tiesJson, a.where.tiesJson)).length,
      ),
    },
    squashnetTeamRoster: {
      findMany: vi.fn(async (a: { where: { snTeamId: { in: string[] } } }) =>
        a.where.snTeamId.in.map((id) => h.rosters.get(id)).filter(Boolean),
      ),
      findUnique: vi.fn(async (a: { where: { snTeamId: string } }) => h.rosters.get(a.where.snTeamId) ?? null),
      upsert: vi.fn(async (a: { where: { snTeamId: string }; create: { rosterJson: string; fetchedAt: Date } }) => {
        h.rosters.set(a.where.snTeamId, { snTeamId: a.where.snTeamId, ...a.create });
      }),
      count: vi.fn(async (a: { where: { rosterJson?: { contains?: string } } }) =>
        [...h.rosters.values()].filter((r) => contient(r.rosterJson, a.where.rosterJson)).length,
      ),
    },
    squashnetPlayer: {
      findUnique: vi.fn(async (a: { where: { regiid: string } }) => h.players.get(a.where.regiid) ?? null),
      upsert: vi.fn(async (a: { where: { regiid: string }; create: { json: string; fetchedAt: Date } }) => {
        h.players.set(a.where.regiid, { regiid: a.where.regiid, ...a.create });
      }),
    },
  },
}));

// Le RÉSEAU seul est simulé : les parseurs, les règles de fraîcheur et d'assemblage sont les vrais.
vi.mock("@/lib/squashnet/pool", async (orig) => ({
  ...(await orig<typeof import("@/lib/squashnet/pool")>()),
  fetchPool: (...a: unknown[]) => h.fetchPool(...a),
}));
vi.mock("@/lib/squashnet/roster", async (orig) => ({
  ...(await orig<typeof import("@/lib/squashnet/roster")>()),
  fetchTeamRoster: (...a: unknown[]) => h.fetchRoster(...a),
}));
vi.mock("@/lib/squashnet/player", async (orig) => ({
  ...(await orig<typeof import("@/lib/squashnet/player")>()),
  fetchPlayer: (...a: unknown[]) => h.fetchPlayer(...a),
}));
// Pas d'attente de politesse entre deux requêtes, dans un test.
vi.mock("@/lib/interclub-roster-db", async (orig) => ({
  ...(await orig<typeof import("@/lib/interclub-roster-db")>()),
  DELAI_MS: 0,
}));

import * as equipe from "./equipe/route";
import * as joueur from "./joueur/route";
import { parsePool } from "@/lib/squashnet/pool";
import { parseTeamRoster } from "@/lib/squashnet/roster";
import { parsePlayer } from "@/lib/squashnet/player";
import { oublierEchecsFiches } from "@/lib/interclub-team-sheet-db";
import { oublierEchecs } from "@/lib/interclub-roster-db";

const pool = parsePool(fixture("poule-2027-h4-poule-b.html"));
const issy = parseTeamRoster(fixture("equipe-2027-176169-aqissy.html"), "176169");
const kadi = parsePlayer(fixture("joueur-2027-644801-fiche.html"), "644801");

const req = (path: string) => ({ nextUrl: new URL(`https://x.test/api/interclub/poule/${path}`) }) as unknown as NextRequest;
const HEURE = 3_600_000;

beforeEach(() => {
  h.access = true;
  h.team = {
    id: "t2",
    snEventId: "ev",
    snDrawId: "52162",
    snRoundId: "383987",
    snStandingsJson: JSON.stringify(pool.standings),
    snStandingsAt: new Date(),
  };
  h.pools.clear();
  h.rosters.clear();
  h.players.clear();
  h.fetchPool.mockReset().mockResolvedValue(pool);
  h.fetchRoster.mockReset().mockResolvedValue(issy);
  h.fetchPlayer.mockReset().mockResolvedValue(kadi);
  oublierEchecsFiches();
  oublierEchecs();
});

describe("/api/interclub/poule/equipe", () => {
  it("401 sans session, 400 sur un identifiant qui n'en est pas un", async () => {
    h.access = false;
    expect((await equipe.GET(req("equipe?snTeamId=176169"))).status).toBe(401);
    h.access = true;
    expect((await equipe.GET(req("equipe?snTeamId=abc"))).status).toBe(400);
  });

  it("404 SANS REQUÊTE pour une équipe absente de nos poules", async () => {
    expect((await equipe.POST(req("equipe?snTeamId=999999"))).status).toBe(404);
    expect(h.fetchPool).not.toHaveBeenCalled();
    expect(h.fetchRoster).not.toHaveBeenCalled();
  });

  it("GET ne sort jamais : il rend ce qu'on a, et dit qu'il faut relire", async () => {
    const res = await equipe.GET(req("equipe?snTeamId=176169"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ team: { name: "Squash in Issy", rank: 1 }, ties: [], roster: null, stale: true });
    expect(h.fetchPool).not.toHaveBeenCalled();
  });

  it("POST relit la poule et l'effectif, puis rend la fiche complète", async () => {
    const body = await (await equipe.POST(req("equipe?snTeamId=176169"))).json();
    expect(h.fetchPool).toHaveBeenCalledTimes(1);
    expect(h.fetchRoster).toHaveBeenCalledWith("176169");
    expect(body.ties[0]).toMatchObject({ round: "J1", homeCode: "VERR5", scoreHome: 1, scoreAway: 3 });
    expect(body.roster).toHaveLength(6);
    expect(body.stale).toBe(false);
  });

  it("POST ne relit pas ce qui est frais", async () => {
    await equipe.POST(req("equipe?snTeamId=176169"));
    await equipe.POST(req("equipe?snTeamId=176169"));
    expect(h.fetchPool).toHaveBeenCalledTimes(1);
    expect(h.fetchRoster).toHaveBeenCalledTimes(1);
  });

  it("une poule qui vient d'échouer n'est pas redemandée à chaque ouverture", async () => {
    h.fetchPool.mockRejectedValue(new Error("502"));
    await equipe.POST(req("equipe?snTeamId=176169"));
    await equipe.POST(req("equipe?snTeamId=176174"));
    expect(h.fetchPool).toHaveBeenCalledTimes(1);
  });

  it("des rencontres de plus de six heures sont relues", async () => {
    await equipe.POST(req("equipe?snTeamId=176169"));
    const p = h.pools.get("383987")!;
    p.fetchedAt = new Date(Date.now() - 7 * HEURE);
    await equipe.POST(req("equipe?snTeamId=176169"));
    expect(h.fetchPool).toHaveBeenCalledTimes(2);
  });
});

describe("/api/interclub/poule/joueur", () => {
  it("404 SANS REQUÊTE pour un joueur absent de nos données", async () => {
    await equipe.POST(req("equipe?snTeamId=176169"));
    expect((await joueur.POST(req("joueur?regiid=123456"))).status).toBe(404);
    expect(h.fetchPlayer).not.toHaveBeenCalled();
  });

  it("GET : ses matchs dans la poule, avant même d'avoir lu sa fiche", async () => {
    await equipe.POST(req("equipe?snTeamId=176169"));
    const body = await (await joueur.GET(req("joueur?regiid=644801"))).json();
    expect(body).toMatchObject({ name: "KADI RAFIK", source: "poule", stale: true });
    expect(body.matches).toHaveLength(2);
    expect(h.fetchPlayer).not.toHaveBeenCalled();
  });

  it("POST lit sa fiche fédérale une fois, puis la sert depuis la base", async () => {
    await equipe.POST(req("equipe?snTeamId=176169"));
    const body = await (await joueur.POST(req("joueur?regiid=644801"))).json();
    expect(body).toMatchObject({ source: "fiche", stale: false });
    expect(body.matches[0]).toMatchObject({ opponentTeam: "Verrieres 4", result: "won" });
    await joueur.POST(req("joueur?regiid=644801"));
    expect(h.fetchPlayer).toHaveBeenCalledTimes(1);
  });

  it("une fiche qui ne répond pas : on sert la poule, sans redemander aussitôt", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await equipe.POST(req("equipe?snTeamId=176169"));
    h.fetchPlayer.mockRejectedValue(new Error("502"));
    const body = await (await joueur.POST(req("joueur?regiid=644801"))).json();
    expect(body).toMatchObject({ source: "poule" });
    await joueur.POST(req("joueur?regiid=644801"));
    expect(h.fetchPlayer).toHaveBeenCalledTimes(1);
  });
});
