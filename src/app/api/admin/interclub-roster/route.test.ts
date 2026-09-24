import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTeamRoster, type TeamRoster } from "@/lib/squashnet/roster";

// ============================================================================
//  LA ROUTE QUI FAIT ENTRER DES JOUEURS DE LA FÉDÉRATION DANS NOS EFFECTIFS.
//
//  Ce qu'on tient ici : la garde d'accès avant toute lecture, le fait que la
//  ligne fédérale soit RELUE EN BASE et jamais reçue du client, et surtout la
//  garde de CLUB — la même table porte les fiches adverses, et une erreur d'un
//  chiffre dans l'ancrage suffirait sans elle à faire entrer huit joueurs de
//  Verrières dans notre roster, alignables, sans que rien ne le dise.
// ============================================================================

const FICHE_VERRIERES: TeamRoster = parseTeamRoster(
  readFileSync(
    join(process.cwd(), "src/lib/squashnet/__fixtures__/equipe-2027-176173-roster-nc.html"),
    "utf8",
  ),
  "176173",
);

/** La même fiche, mais publiée sous NOTRE club — ce que la fédération rend pour nos équipes. */
const FICHE_NOTRE: TeamRoster = { ...FICHE_VERRIERES, club: "Squash de l yvette" };

const h = vi.hoisted(() => ({
  admin: true,
  team: null as null | { id: string; name: string; snTeamId: string | null },
  roster: null as null | unknown,
  membres: [] as unknown[],
  invites: [] as unknown[],
  guestCount: 0,
  createGuest: vi.fn(),
  updateUser: vi.fn(),
  updateGuest: vi.fn(),
  deleteGuest: vi.fn(),
  updateMatches: vi.fn(),
  findMatches: vi.fn(),
  findGuest: vi.fn(),
  findUser: vi.fn(),
  refreshRosters: vi.fn(),
}));

vi.mock("@/lib/admin", () => ({ requireAdmin: vi.fn(async () => h.admin) }));
vi.mock("@/lib/interclub-access", () => ({ interclubDisabledResponse: vi.fn(async () => null) }));
vi.mock("@/lib/interclub-roster", () => ({ teamGuest: vi.fn(async (id: string) => ({ id })) }));
vi.mock("@/lib/interclub-roster-db", () => ({
  loadRosters: vi.fn(async (ids: string[]) =>
    h.roster ? new Map([[ids[0], h.roster]]) : new Map(),
  ),
  refreshRosters: (...a: unknown[]) => h.refreshRosters(...a),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    interclubTeam: { findUnique: vi.fn(async () => h.team) },
    squashnetTeamRoster: { findUnique: vi.fn(async () => ({ fetchedAt: new Date(0) })) },
    user: {
      findMany: vi.fn(async () => h.membres),
      findFirst: (...a: unknown[]) => h.findUser(...a),
      updateMany: (...a: unknown[]) => h.updateUser(...a),
    },
    interclubGuest: {
      findMany: vi.fn(async () => h.invites),
      findFirst: (...a: unknown[]) => h.findGuest(...a),
      count: vi.fn(async () => h.guestCount),
      create: (...a: unknown[]) => h.createGuest(...a),
      updateMany: (...a: unknown[]) => h.updateGuest(...a),
      delete: (...a: unknown[]) => h.deleteGuest(...a),
    },
    interclubMatch: {
      findMany: (...a: unknown[]) => h.findMatches(...a),
      updateMany: (...a: unknown[]) => h.updateMatches(...a),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        interclubMatch: { updateMany: (...a: unknown[]) => h.updateMatches(...a) },
        user: { updateMany: (...a: unknown[]) => h.updateUser(...a) },
        interclubGuest: { delete: (...a: unknown[]) => h.deleteGuest(...a) },
      }),
    ),
  },
}));

import { GET, POST } from "./route";

const get = (qs = "?teamId=t1") =>
  ({ nextUrl: new URL(`https://x.test/api/admin/interclub-roster${qs}`) }) as unknown as NextRequest;
const post = (body: unknown) => ({ json: async () => body }) as unknown as NextRequest;

beforeEach(() => {
  h.admin = true;
  h.team = { id: "t1", name: "Équipe 2", snTeamId: "176168" };
  h.roster = FICHE_NOTRE;
  h.membres = [];
  h.invites = [];
  h.guestCount = 0;
  h.createGuest.mockReset().mockResolvedValue({ id: "g-new" });
  h.updateUser.mockReset().mockResolvedValue({ count: 1 });
  h.updateGuest.mockReset().mockResolvedValue({ count: 1 });
  h.deleteGuest.mockReset().mockResolvedValue({});
  h.updateMatches.mockReset().mockResolvedValue({ count: 0 });
  h.findMatches.mockReset().mockResolvedValue([]);
  h.findGuest.mockReset().mockResolvedValue(null);
  h.findUser.mockReset().mockResolvedValue(null);
  h.refreshRosters.mockReset().mockResolvedValue([{ snTeamId: "176168", status: "fetched" }]);
});

describe("l'accès, avant toute chose", () => {
  it("403 pour un non-admin, sans lire quoi que ce soit", async () => {
    h.admin = false;
    expect((await GET(get())).status).toBe(403);
    expect((await POST(post({ action: "refresh", teamId: "t1" }))).status).toBe(403);
    expect(h.refreshRosters).not.toHaveBeenCalled();
  });

  it("une équipe sans ancrage le DIT, au lieu de rendre une fiche vide", async () => {
    // « 0 joueur » enverrait chercher la panne du côté de la fédération alors que la
    // configuration manque ici. Même doctrine que l'import du calendrier.
    h.team = { id: "t1", name: "Équipe 2", snTeamId: null };
    const res = await GET(get());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/pas rattachée/);
  });
});

describe("GET — la fiche appariée", () => {
  it("apparie les membres de l'équipe, et signale les lignes sans personne", async () => {
    h.membres = [{ id: "u1", displayName: "Emmanuel Launay", snLicence: null }];
    const body = await (await GET(get())).json();
    expect(body.etat).toBe("ok");
    expect(body.lignes).toHaveLength(8);
    const lie = body.lignes.filter((l: { appariement: { statut: string } }) => l.appariement.statut === "lie");
    expect(lie).toHaveLength(1);
    expect(lie[0].appariement.joueur.id).toBe("u1");
    expect(body.lignes.filter((l: { appariement: { statut: string } }) => l.appariement.statut === "inconnu")).toHaveLength(7);
  });

  it("⚠️ ne rend AUCUN rang mixte pour un NC — la sentinelle 9311 n'est pas un rang", async () => {
    const body = await (await GET(get())).json();
    const nc = body.lignes.filter((l: { player: { clt: string } }) => l.player.clt === "NC");
    expect(nc).toHaveLength(7);
    for (const l of nc) {
      expect(l.player.rangM).toBe(9311);
      expect(l.valeurs).toMatchObject({ clt: "NC", rangM: null });
    }
  });

  it("⚠️ REFUSE une fiche qui n'est pas celle de notre club, et nomme le club reçu", async () => {
    // Les fiches adverses vivent dans la même table : c'est elle qui sert le menu « en face ».
    // Sans cette garde, une erreur d'un chiffre dans l'ancrage ferait entrer huit joueurs de
    // Verrières dans notre effectif. Nommer le club reçu est ce qui permet de trouver l'erreur.
    h.roster = FICHE_VERRIERES;
    const body = await (await GET(get())).json();
    expect(body.etat).toBe("autre_club");
    expect(body.clubRecu).toMatch(/verrieres/i);
    expect(body.lignes).toEqual([]);
  });

  it("distingue « jamais téléchargée » de « mauvais club »", async () => {
    // Les confondre enverrait chercher une panne de la fédération là où c'est notre
    // configuration qui est fausse.
    h.roster = null;
    const body = await (await GET(get())).json();
    expect(body.etat).toBe("absente");
    expect(body.clubRecu).toBeNull();
  });

  it("signale un membre que la fédération n'a pas inscrit", async () => {
    h.membres = [{ id: "u1", displayName: "Jean Dupont", snLicence: null }];
    const body = await (await GET(get())).json();
    expect(body.absents.map((j: { id: string }) => j.id)).toEqual(["u1"]);
  });

  it("⚠️ un membre en DOUBLON d'un invité n'est pas compté comme absent", async () => {
    // Il est inscrit chez la fédération, sous la ligne que l'invité porte encore. Le compter
    // deux fois ferait lire « pas inscrit » sur quelqu'un qui l'est.
    h.membres = [{ id: "u1", displayName: "Eric Doxat", snLicence: null }];
    h.invites = [{ id: "g1", name: "DOXAT ERIC", snLicence: "1528030W" }];
    const body = await (await GET(get())).json();
    expect(body.doublons).toHaveLength(1);
    expect(body.doublons[0]).toMatchObject({ par: "nom" });
    expect(body.absents).toEqual([]);
  });
});

describe("create_guest — l'invité né de la fiche", () => {
  it("écrit licence, classement et rang DEPUIS la ligne, sans chercher au classement", async () => {
    // Ce chemin sert d'abord les NC, que le classement national ne contient pas : une recherche
    // rendrait « introuvable » et ferait croire à un problème là où la fiche vient de tout dire.
    const res = await POST(post({ action: "create_guest", teamId: "t1", licence: "1528030W" }));
    expect(res.status).toBe(201);
    expect(h.createGuest).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          teamId: "t1",
          name: "DOXAT ERIC",
          snLicence: "1528030W",
          rosterClt: "NC",
          rosterRangM: null,
        }),
      }),
    );
  });

  it("reprend le classement ET le rang d'un joueur classé", async () => {
    await POST(post({ action: "create_guest", teamId: "t1", licence: "1463138W" }));
    expect(h.createGuest.mock.calls[0][0].data).toMatchObject({ rosterClt: "4D", rosterRangM: 2296 });
  });

  it("⚠️ une licence qui ne figure pas sur la fiche est REFUSÉE", async () => {
    // La ligne est relue en base, jamais reçue du client : sinon n'importe quel classement et
    // n'importe quelle licence pourraient être posés sur n'importe qui par un appel forgé — et
    // c'est exactement ce dont dépend l'ordre des simples.
    const res = await POST(post({ action: "create_guest", teamId: "t1", licence: "0000000" }));
    expect(res.status).toBe(409);
    expect(h.createGuest).not.toHaveBeenCalled();
  });

  it("⚠️ refuse de créer depuis la fiche d'un AUTRE club", async () => {
    h.roster = FICHE_VERRIERES;
    const res = await POST(post({ action: "create_guest", teamId: "t1", licence: "1528030W" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/autre club/i);
    expect(h.createGuest).not.toHaveBeenCalled();
  });

  it("dit quoi faire quand aucune fiche n'a été téléchargée", async () => {
    h.roster = null;
    const res = await POST(post({ action: "create_guest", teamId: "t1", licence: "1528030W" }));
    expect((await res.json()).error).toMatch(/Rafraîchis/);
  });
});

describe("link / unlink", () => {
  it("lie un membre, en le bornant à SON équipe", async () => {
    // Un identifiant de membre d'une autre équipe ne doit pas pouvoir recevoir une ligne de
    // celle-ci. La garde est dans la requête, pas dans une lecture préalable.
    const res = await POST(
      post({ action: "link", teamId: "t1", licence: "1463138W", kind: "member", id: "u1" }),
    );
    expect(res.status).toBe(200);
    expect(h.updateUser).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "u1", teamId: "t1" },
        data: expect.objectContaining({ snLicence: "1463138W", snRosterClt: "4D", snRosterRangM: 2296 }),
      }),
    );
  });

  it("404 si le membre n'est pas dans cette équipe", async () => {
    h.updateUser.mockResolvedValue({ count: 0 });
    expect(
      (await POST(post({ action: "link", teamId: "t1", licence: "1463138W", kind: "member", id: "u9" })))
        .status,
    ).toBe(404);
  });

  it("défaire une liaison n'exige AUCUN ancrage — c'est ce qu'on vient corriger", async () => {
    // Un `teamId` obligatoire ici empêcherait de défaire la liaison faite avec le mauvais
    // identifiant d'équipe, c'est-à-dire exactement la situation qu'on veut réparer.
    const res = await POST(post({ action: "unlink", kind: "guest", id: "g1" }));
    expect(res.status).toBe(200);
    expect(h.updateGuest).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { snLicence: null, rosterClt: null, rosterRangM: null, rosterAt: null },
      }),
    );
  });
});

describe("promote_guest — l'invité qui a désormais un compte", () => {
  beforeEach(() => {
    h.findUser.mockResolvedValue({ id: "u1" });
    h.findGuest.mockResolvedValue({
      id: "g1",
      snLicence: "1528030W",
      rosterClt: "NC",
      rosterRangM: null,
      rosterAt: new Date(0),
    });
  });

  it("⚠️ RÉATTRIBUE les simples à venir AVANT de supprimer l'invité", async () => {
    // Sans cette étape, la suppression laisserait des lignes de composition avec un nom figé
    // mais plus personne derrière : ni disponibilité, ni revendication, ni ordre vérifiable. La
    // rencontre aurait l'air composée, et ne le serait plus.
    h.findMatches.mockResolvedValue([{ id: "m1" }, { id: "m2" }]);
    h.updateMatches.mockResolvedValue({ count: 2 });
    const res = await POST(post({ action: "promote_guest", teamId: "t1", userId: "u1", guestId: "g1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, deplaces: 2 });
    expect(h.updateMatches).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["m1", "m2"] }, homeGuestId: "g1" },
        data: { homeGuestId: null, homeUserId: "u1" },
      }),
    );
    expect(h.deleteGuest).toHaveBeenCalledWith({ where: { id: "g1" } });
  });

  it("ne déplace QUE les rencontres dont aucun jeu n'est marqué", async () => {
    // On ne découpe pas une soirée en cours, et on ne réécrit pas l'histoire : les rencontres
    // passées gardent le nom figé de l'invité.
    await POST(post({ action: "promote_guest", teamId: "t1", userId: "u1", guestId: "g1" }));
    expect(h.findMatches).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          homeGuestId: "g1",
          interclub: { matches: { every: { gamesHome: 0, gamesAway: 0 } } },
        }),
      }),
    );
  });

  it("recopie sur le membre ce que l'invité tenait de la FICHE, et rien d'autre", async () => {
    await POST(post({ action: "promote_guest", teamId: "t1", userId: "u1", guestId: "g1" }));
    const data = h.updateUser.mock.calls.at(-1)?.[0].data;
    expect(data).toEqual({
      snLicence: "1528030W",
      snRosterClt: "NC",
      snRosterRangM: null,
      snRosterAt: new Date(0),
    });
    // La correction admin de l'invité ne suit pas : elle a été posée pour un joueur sans
    // compte, et le membre a la sienne, qui peut déjà dire autre chose.
    expect(Object.keys(data)).not.toContain("interclubCltOverride");
  });

  it("404 sans rien supprimer si l'un des deux n'est pas dans l'équipe", async () => {
    h.findGuest.mockResolvedValue(null);
    expect(
      (await POST(post({ action: "promote_guest", teamId: "t1", userId: "u1", guestId: "g9" }))).status,
    ).toBe(404);
    expect(h.deleteGuest).not.toHaveBeenCalled();
  });
});

describe("refresh", () => {
  it("retélécharge NOTRE fiche, et relaie le verdict tel quel", async () => {
    // `fetched` / `fresh` / `unreadable` / `failed` restent distincts jusqu'à l'écran : le
    // premier appelle une recapture, le second d'attendre.
    h.refreshRosters.mockResolvedValue([{ snTeamId: "176168", status: "unreadable" }]);
    const body = await (await POST(post({ action: "refresh", teamId: "t1", force: true }))).json();
    expect(h.refreshRosters).toHaveBeenCalledWith(["176168"], { force: true });
    expect(body.outcome.status).toBe("unreadable");
  });
});
