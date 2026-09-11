import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  access: { ok: true } as { ok: boolean; status?: number },
  rencontres: [] as Array<Record<string, unknown>>,
  findMany: vi.fn(),
}));

vi.mock("@/lib/interclub-access", () => ({
  requireInterclubMember: vi.fn(async () =>
    h.access.ok
      ? { ok: true, session: { userId: "u1" } }
      : { ok: false, response: new Response(null, { status: h.access.status ?? 401 }) as unknown },
  ),
}));
vi.mock("@/lib/db", () => ({
  prisma: { interclub: { findMany: (...a: unknown[]) => h.findMany(...a) } },
}));

import { GET } from "./route";

const req = (qs = "?teamId=t1") =>
  ({ nextUrl: new URL(`https://x.test/api/interclub/opponents${qs}`) }) as unknown as NextRequest;

beforeEach(() => {
  h.access = { ok: true };
  h.rencontres = [];
  h.findMany.mockReset().mockImplementation(async () => h.rencontres);
});

describe("GET /api/interclub/opponents", () => {
  it("relaie le refus du contrôle d'accès sans rien lire", async () => {
    h.access = { ok: false, status: 401 };
    expect((await GET(req())).status).toBe(401);
    expect(h.findMany).not.toHaveBeenCalled();
  });

  // L'ORDRE DE LECTURE EST UNE RÈGLE, pas un détail : `mergeOpponents` retient le nom LE PLUS
  // RÉCENT. À l'envers, la première orthographe l'emporterait — exactement celle qu'une
  // correction ultérieure était censée remplacer.
  // ⚠️ CE TEST AFFIRMAIT « asc », ET FIGEAIT AINSI LE DÉFAUT. `take` s'applique APRÈS le tri :
  // en croissant, il retenait les 40 rencontres LES PLUS ANCIENNES — celles dont on n'a plus
  // rien à faire. Passé la quarantième rencontre enregistrée, le menu se figeait sur la première
  // saison et la poule EN COURS disparaissait, sans un message.
  it("retient les rencontres LES PLUS RÉCENTES, et borne la profondeur", async () => {
    await GET(req());
    const args = h.findMany.mock.calls[0][0] as { orderBy: unknown; take: number; where: unknown };
    expect(args.orderBy).toEqual({ date: "desc" });
    expect(args.take).toBe(40);
    expect(args.where).toEqual({ teamId: "t1" });
  });

  // L'autre moitié de la correction, et elle compte autant : `mergeOpponents` retient le nom LE
  // PLUS RÉCENT, ce qui n'a de sens que si les rencontres lui arrivent dans l'ordre. Lues
  // décroissant sans être remises à l'endroit, c'est la PREMIÈRE orthographe qui l'emporterait —
  // exactement celle qu'une correction ultérieure était censée remplacer.
  it("rend les rencontres à la fusion dans l'ordre chronologique", async () => {
    h.rencontres = [
      // Tel que la base les rend : la plus récente d'abord.
      { opponent: "Chaville 4", matches: [{ awayName: "Détry" }], official: null },
      { opponent: "Chaville 4", matches: [{ awayName: "detry" }], official: null },
    ];
    const res = await GET(req());
    const { players } = (await res.json()) as { players: { name: string }[] };
    expect(players).toHaveLength(1);
    expect(players[0].name).toBe("Détry");
  });

  it("sans équipe, ne filtre pas plutôt que de filtrer sur rien", async () => {
    await GET(req(""));
    expect((h.findMany.mock.calls[0][0] as { where: unknown }).where).toEqual({});
  });

  // C'EST TOUT L'INTÉRÊT DU MODULE : aucun appel à squashnet, tout vient de nos propres données.
  it("rend les équipes et les joueurs déjà rencontrés, sans toucher à la fédération", async () => {
    h.rencontres = [
      {
        opponent: "Chaville 4",
        matches: [{ awayName: "Paul Martin" }, { awayName: "À désigner" }],
        official: {
          checkJson: JSON.stringify({
            checkedAt: "2026-09-01T10:00:00.000Z",
            players: [
              {
                order: 1,
                side: "away",
                name: "Paul Martin",
                verdict: "found",
                fedName: "MARTIN PAUL",
                clt: "4D",
                rangM: 2318,
                licence: "0121214",
                club: "Chaville",
                hint: null,
              },
            ],
            scores: [],
            tie: { ok: true, home: 2, away: 2, undecided: 0, problem: null },
            awayOrder: { status: "ok", problem: null },
          }),
        },
      },
      { opponent: "UCPA Meudon 2", matches: [{ awayName: "Zoe Inconnue" }], official: null },
    ];
    const body = await (await GET(req())).json();
    expect(body.teams).toEqual(["Chaville 4", "UCPA Meudon 2"]);
    // Le confirmé en tête : c'est le seul sur lequel l'ordre des simples pourra être vérifié.
    expect(body.players[0]).toMatchObject({
      name: "Paul Martin",
      team: "Chaville 4",
      fedName: "MARTIN PAUL",
      clt: "4D",
      rangM: 2318,
      licence: "0121214",
    });
    // « À désigner » n'est pas un joueur, et n'a rien à faire dans un menu d'adversaires.
    expect(body.players.map((p: { name: string }) => p.name)).not.toContain("À désigner");
  });

  it("une rencontre jamais vérifiée ne fait pas tomber la liste", async () => {
    h.rencontres = [{ opponent: "Chaville 4", matches: [{ awayName: "Paul Martin" }], official: null }];
    const body = await (await GET(req())).json();
    expect(body.players[0]).toMatchObject({ name: "Paul Martin", clt: null, rangM: null });
  });
});
