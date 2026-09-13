import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// ============================================================================
//  LA SEULE ROUTE OUVERTE À TOUT MEMBRE QUI SORT CHEZ LA FÉDÉRATION.
//
//  Elle n'avait aucun test, alors que c'est celle dont un défaut se paie chez
//  quelqu'un d'autre : jusqu'à `MAX_RENCONTRES` requêtes par appel vers un site
//  associatif, et `?force=1` court-circuite la fraîcheur d'une semaine. Ce qu'on
//  tient ici : la garde d'accès AVANT toute lecture, la profondeur qui reste
//  celle du menu, et le fait qu'une rencontre sans identifiant fédéral ne sorte
//  pas du tout — c'est un confort absent, pas une panne.
// ============================================================================

const h = vi.hoisted(() => ({
  access: { ok: true } as { ok: boolean; status?: number },
  fixture: null as null | { snOpponentTeamId: string | null },
  rencontres: [] as Array<{ snOpponentTeamId: string | null }>,
  findUnique: vi.fn(),
  findMany: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/lib/interclub-access", () => ({
  requireInterclubMember: vi.fn(async () =>
    h.access.ok
      ? { ok: true, session: { userId: "u1" } }
      : { ok: false, response: new Response(null, { status: h.access.status ?? 401 }) as unknown },
  ),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    interclub: {
      findUnique: (...a: unknown[]) => h.findUnique(...a),
      findMany: (...a: unknown[]) => h.findMany(...a),
    },
  },
}));
vi.mock("@/lib/interclub-roster-db", () => ({
  refreshRosters: (...a: unknown[]) => h.refresh(...a),
}));

import { POST } from "./route";
import { MAX_RENCONTRES } from "@/lib/interclub-opponents-db";

const req = (qs = "?teamId=t1") =>
  ({
    nextUrl: new URL(`https://x.test/api/interclub/opponents/refresh${qs}`),
  }) as unknown as NextRequest;

beforeEach(() => {
  h.access = { ok: true };
  h.fixture = null;
  h.rencontres = [];
  h.findUnique.mockReset().mockImplementation(async () => h.fixture);
  h.findMany.mockReset().mockImplementation(async () => h.rencontres);
  h.refresh.mockReset().mockResolvedValue([]);
});

describe("POST /api/interclub/opponents/refresh", () => {
  it("relaie le refus du contrôle d'accès SANS sortir chez la fédération", async () => {
    // La garde vient avant tout le reste : c'est elle qui empêche que la sortie réseau soit
    // déclenchée par n'importe qui.
    h.access = { ok: false, status: 401 };
    expect((await POST(req())).status).toBe(401);
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.findMany).not.toHaveBeenCalled();
    expect(h.findUnique).not.toHaveBeenCalled();
  });

  describe("par rencontre (`fixtureId`) — UNE équipe, pas la poule", () => {
    it("ne rafraîchit que l'adversaire de CETTE rencontre", async () => {
      // Composer contre Verrieres 3 n'a aucune raison d'aller relire les quatre autres clubs.
      h.fixture = { snOpponentTeamId: "161092" };
      h.refresh.mockResolvedValue([{ snTeamId: "161092", status: "fetched", players: 6 }]);

      const res = await POST(req("?fixtureId=f1"));
      expect(res.status).toBe(200);
      expect(h.refresh).toHaveBeenCalledWith(["161092"], { force: false });
      expect(h.findMany).not.toHaveBeenCalled();
      expect(await res.json()).toMatchObject({ ok: true, fetched: 1 });
    });

    it("⚠️ l'identifiant fédéral est relu EN BASE, jamais reçu du client", async () => {
      // Sinon n'importe quel membre ferait interroger n'importe quelle équipe de France.
      h.fixture = { snOpponentTeamId: "161092" };
      await POST(req("?fixtureId=f1&snOpponentTeamId=999999"));
      expect(h.refresh).toHaveBeenCalledWith(["161092"], { force: false });
    });

    it("une rencontre inconnue ou sans identifiant ne sort pas, et ne se plaint pas", async () => {
      // Ce chemin est déclenché par l'OUVERTURE d'un écran : un écran ne doit pas se plaindre
      // d'un confort absent.
      h.fixture = null;
      const res = await POST(req("?fixtureId=inconnue"));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, teams: [] });
      expect(h.refresh).not.toHaveBeenCalled();
    });
  });

  describe("par équipe — la poule, à la profondeur du menu", () => {
    it("lit exactement `MAX_RENCONTRES` rencontres, les plus RÉCENTES", async () => {
      // Croissant, le `take` retiendrait les plus anciennes, et la poule en cours ne serait
      // jamais rafraîchie passé la quarantième rencontre. Même profondeur que `mergeOpponents` :
      // deux profondeurs iraient chercher un roster que personne n'affiche.
      h.rencontres = [{ snOpponentTeamId: "1" }, { snOpponentTeamId: "2" }];
      await POST(req());
      expect(h.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: MAX_RENCONTRES, orderBy: { date: "desc" } }),
      );
    });

    it("dédoublonne les équipes et écarte les rencontres sans identifiant", async () => {
      h.rencontres = [
        { snOpponentTeamId: "1" },
        { snOpponentTeamId: "1" },
        { snOpponentTeamId: null },
        { snOpponentTeamId: "2" },
      ];
      await POST(req());
      expect(h.refresh).toHaveBeenCalledWith(["1", "2"], { force: false });
    });

    it("aucun identifiant → un CONSEIL, et aucune sortie réseau", async () => {
      // C'est un cas normal, pas une panne : les rencontres importées avant que
      // `snOpponentTeamId` n'existe le portent à NULL, et seul un ré-import peut le poser.
      // Sans ce message, l'écran afficherait « 0 équipe » et laisserait chercher l'explication
      // du côté du roster, où il n'y en a pas.
      h.rencontres = [{ snOpponentTeamId: null }];
      const res = await POST(req());
      expect(res.status).toBe(200);
      expect((await res.json()).hint).toMatch(/Réimportez le calendrier/);
      expect(h.refresh).not.toHaveBeenCalled();
    });

    it("`force=1` traverse la fraîcheur d'une semaine", async () => {
      h.rencontres = [{ snOpponentTeamId: "1" }];
      await POST(req("?teamId=t1&force=1"));
      expect(h.refresh).toHaveBeenCalledWith(["1"], { force: true });
    });
  });

  it("⚠️ garde `unreadable` et `failed` SÉPARÉS jusqu'à l'écran", async () => {
    // Le premier veut dire que le rendu de squashnet a changé et qu'il faut recapter une
    // fixture ; le second qu'ils n'ont pas répondu et qu'il faut réessayer. Les confondre
    // enverrait chercher un bug qui n'existe pas.
    h.rencontres = [{ snOpponentTeamId: "1" }, { snOpponentTeamId: "2" }];
    h.refresh.mockResolvedValue([
      { snTeamId: "1", status: "unreadable" },
      { snTeamId: "2", status: "failed" },
    ]);
    const body = await (await POST(req())).json();
    expect(body.unreadable).toEqual(["1"]);
    expect(body.failed).toEqual(["2"]);
  });
});
