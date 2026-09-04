import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// Cette route ne répartit plus les membres « en alternance » (outil de recette supprimé) :
// elle sert le roster des équipes et gère les joueurs SANS COMPTE. L'affectation des membres
// inscrits, elle, vit dans /api/admin/members (action "set_team").

const h = vi.hoisted(() => ({
  interclub: true,
  admin: null as null | { userId: string; email: string },
  teams: [] as Array<Record<string, unknown>>,
  /** Membres rattachés à une équipe, tels que `allTeamMembers` les relit. */
  members: [] as Array<Record<string, unknown>>,
  /** Le `where` de la requête des membres — pour vérifier ce qu'elle exclut. */
  whereMembres: null as null | Record<string, unknown>,
  guests: [] as Array<Record<string, unknown>>,
  team: null as null | Record<string, unknown>,
  created: null as null | Record<string, unknown>,
  deleted: 0,
  /** Force le `create` à échouer comme le ferait la contrainte @@unique([teamId, name]). */
  duplicate: false,
  updated: null as null | Record<string, unknown>,
  updatedCount: 1,
  /** Verdict que le rapprochement squashnet doit rendre — la couche réseau est mockée. */
  matchStatus: "matched" as "matched" | "moved" | "unknown",
  matchGuestRanking: vi.fn(),
  /** Le membre que `user.findUnique` rend — sujet de `set_captain`. */
  user: null as null | { teamId: string | null; displayName: string; nickname: string | null },
  /** Ce qu'un `interclubTeam.update` a reçu, ou null s'il n'a pas eu lieu. */
  teamUpdated: null as null | { where: unknown; data: Record<string, unknown> },
}));

vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({ interclub: h.interclub }),
}));
vi.mock("@/lib/admin", () => ({ requireAdmin: vi.fn(async () => h.admin) }));
// Le rapprochement squashnet est éprouvé chez lui (`squashnet/refresh.test.ts`) : ici on
// vérifie seulement que la route le DÉCLENCHE et rapporte son verdict, sans réseau.
vi.mock("@/lib/squashnet/refresh", () => ({ matchGuestRanking: h.matchGuestRanking }));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        h.whereMembres = args.where;
        return h.members;
      }),
      findUnique: vi.fn(async () => h.user),
    },
    interclubTeam: {
      findMany: vi.fn(async () => h.teams),
      findUnique: vi.fn(async () => h.team),
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        h.teamUpdated = args;
        return args.data;
      }),
    },
    interclubGuest: {
      findMany: vi.fn(async () => h.guests),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        (h.guests as Array<Record<string, unknown>>).find((g) => g.id === where.id) ?? null,
      ),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        if (h.duplicate) {
          const { Prisma } = await import("@prisma/client");
          throw new Prisma.PrismaClientKnownRequestError("unique", {
            code: "P2002",
            clientVersion: "test",
          });
        }
        h.created = args.data;
        return { id: "g-new", ...args.data };
      }),
      updateMany: vi.fn(async (args: { data: Record<string, unknown> }) => {
        h.updated = args.data;
        return { count: h.updatedCount };
      }),
      deleteMany: vi.fn(async () => ({ count: h.deleted })),
    },
  },
}));

import { GET, POST } from "./route";

const get = () => ({ cookies: { get: () => undefined } }) as unknown as NextRequest;
const post = (body: unknown) =>
  ({ cookies: { get: () => undefined }, json: async () => body }) as unknown as NextRequest;

beforeEach(() => {
  h.interclub = true;
  h.admin = { userId: "admin1", email: "admin@example.com" };
  h.teams = [
    {
      id: "t1",
      name: "Équipe 1",
      captainId: null,
      captain: null,
      snEventId: null,
      snTeamId: null,
      snCheckedAt: null,
    },
  ];
  h.user = null;
  h.teamUpdated = null;
  h.members = [
    {
      id: "u1",
      teamId: "t1",
      displayName: "Jérôme Blanc",
      nickname: "Jéjé",
      interclubCltOverride: null,
      squashnetRanking: { clt: "5A", rangM: 412 },
    },
  ];
  h.whereMembres = null;
  h.guests = [
    {
      id: "g1",
      teamId: "t1",
      name: "Paul Hors-Appli",
      cltOverride: null,
      rangMOverride: null,
      snClt: "5A",
      snRangM: 1200,
      snStatus: "matched",
      snCheckedAt: null,
    },
  ];
  h.team = { id: "t1", _count: { guests: 1 } };
  h.created = null;
  h.deleted = 1;
  h.duplicate = false;
  h.updated = null;
  h.updatedCount = 1;
  h.matchStatus = "matched";
  h.matchGuestRanking.mockReset().mockImplementation(async () => h.matchStatus);
});

describe("GET /api/admin/interclub-teams", () => {
  it("404 si la fonction est désactivée", async () => {
    h.interclub = false;
    expect((await GET(get())).status).toBe(404);
  });

  it("403 si l'appelant n'est pas admin", async () => {
    h.admin = null;
    expect((await GET(get())).status).toBe(403);
  });

  it("rend les équipes avec leur effectif inscrit, et les joueurs hors appli", async () => {
    const body = await (await GET(get())).json();
    // Exhaustif À DESSEIN : cet objet est le contrat de l'écran d'admin. Le capitaine et
    // l'ancrage fédéral s'y règlent, donc s'y lisent — et un champ ajouté sans être affiché
    // doit faire échouer ce test plutôt que passer inaperçu.
    expect(body.teams).toEqual([
      {
        id: "t1",
        name: "Équipe 1",
        memberCount: 1,
        captainId: null,
        captainName: null,
        snEventId: null,
        snTeamId: null,
        snCheckedAt: null,
      },
    ]);
    // `clt`/`rangM` EFFECTIFS, plus les deux étages qui les produisent : l'écran doit pouvoir
    // dire d'où vient le classement, et préremplir la correction avec la CORRECTION existante
    // (jamais avec la valeur rapprochée, qu'il figerait sinon au premier enregistrement).
    expect(body.guests).toEqual([
      {
        id: "g1",
        teamId: "t1",
        name: "Paul Hors-Appli",
        clt: "5A",
        rangM: 1200,
        cltOverride: null,
        rangMOverride: null,
        snClt: "5A",
        snRangM: 1200,
        snStatus: "matched",
        snCheckedAt: null,
      },
    ]);
  });

  it("le classement d'un invité suit la correction admin quand il y en a une", async () => {
    h.guests = [
      {
        id: "g1",
        teamId: "t1",
        name: "Paul Hors-Appli",
        cltOverride: "4D",
        rangMOverride: 800,
        snClt: "5A",
        snRangM: 1200,
        snStatus: "matched",
        snCheckedAt: null,
      },
    ];
    const body = await (await GET(get())).json();
    expect(body.guests[0]).toMatchObject({ clt: "4D", rangM: 800, snClt: "5A" });
  });

  // L'écran s'appelle « effectif » : un décompte ne dit ni QUI en fait partie, ni à quel
  // classement il joue — or c'est le classement qui décide de l'ordre des simples. La liste
  // nominative des membres était pourtant absente de la réponse.
  it("rend les MEMBRES nominativement, avec leur classement effectif et leur équipe", async () => {
    const body = await (await GET(get())).json();
    expect(body.members).toEqual([
      { kind: "member", id: "u1", teamId: "t1", name: "Jéjé", clt: "5A", rangM: 412 },
    ]);
  });

  it("le classement d'un membre suit la correction admin quand il y en a une", async () => {
    h.members = [
      {
        id: "u1",
        teamId: "t1",
        displayName: "Jérôme Blanc",
        nickname: null,
        interclubCltOverride: "4D",
        squashnetRanking: { clt: "5A", rangM: 412 },
      },
    ];
    const body = await (await GET(get())).json();
    // La correction l'emporte sur le rapprochement, comme partout ailleurs (`memberClt`) — mais
    // le rang, lui, ne peut venir que de squashnet : une correction ne porte qu'un classement.
    expect(body.members[0]).toMatchObject({ clt: "4D", rangM: 412 });
  });

  it("exclut les comptes désactivés et les membres sans équipe", async () => {
    await GET(get());
    expect(h.whereMembres).toEqual({ teamId: { not: null }, disabledAt: null });
  });
});

describe("POST /api/admin/interclub-teams", () => {
  it("403 si l'appelant n'est pas admin", async () => {
    h.admin = null;
    expect((await POST(post({ action: "add_guest", teamId: "t1", name: "X" }))).status).toBe(403);
  });

  it("inscrit un joueur sans compte au roster d'une équipe", async () => {
    const res = await POST(post({ action: "add_guest", teamId: "t1", name: "Jean Dupont" }));
    expect(res.status).toBe(201);
    // Aucun classement à l'écriture : il est CHERCHÉ, pas saisi.
    expect(h.created).toEqual({ teamId: "t1", name: "Jean Dupont" });
  });

  it("cherche le classement sur squashnet dès l'inscription, et rapporte le verdict", async () => {
    // C'est le seul moment où le nom est encore sous les yeux de l'admin, donc le seul où
    // « pas trouvé » est actionnable : il corrige l'orthographe, ou force le classement.
    const res = await POST(post({ action: "add_guest", teamId: "t1", name: "Jean Dupont" }));
    // `objectContaining` : le faux `create` ignore le `select` de la route et rend toute la
    // ligne, là où le vrai n'en rendrait que l'id et le nom.
    expect(h.matchGuestRanking).toHaveBeenCalledWith(
      expect.objectContaining({ id: "g-new", name: "Jean Dupont" }),
    );
    expect((await res.json()).status).toBe("matched");
  });

  it("inscrit quand même le joueur que squashnet ne retrouve pas — le repli manuel est là pour ça", async () => {
    h.matchStatus = "unknown";
    const res = await POST(post({ action: "add_guest", teamId: "t1", name: "Jean Dupont" }));
    expect(res.status).toBe(201);
    expect((await res.json()).status).toBe("unknown");
  });

  // Sans normalisation, « Jean  Dupont » et « Jean Dupont » seraient deux joueurs distincts
  // et l'unicité par nom se contournerait d'une frappe.
  it("normalise les espaces du nom", async () => {
    await POST(post({ action: "add_guest", teamId: "t1", name: "  Jean   Dupont " }));
    expect(h.created?.name).toBe("Jean Dupont");
  });

  it("refuse un nom vide", async () => {
    expect((await POST(post({ action: "add_guest", teamId: "t1", name: "   " }))).status).toBe(400);
  });

  it("refuse une équipe inconnue", async () => {
    h.team = null;
    expect((await POST(post({ action: "add_guest", teamId: "tX", name: "Jean" }))).status).toBe(400);
  });

  it("traduit le doublon en 409 plutôt qu'en 500", async () => {
    h.duplicate = true;
    const res = await POST(post({ action: "add_guest", teamId: "t1", name: "Paul Hors-Appli" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/déjà/i);
  });

  it("borne le nombre de joueurs hors appli par équipe", async () => {
    h.team = { id: "t1", _count: { guests: 40 } };
    const res = await POST(post({ action: "add_guest", teamId: "t1", name: "Un de trop" }));
    expect(res.status).toBe(400);
    expect(h.created).toBeNull();
  });

  it("force le classement ET le rang mixte d'un invité déjà inscrit", async () => {
    const res = await POST(
      post({ action: "set_guest_ranking", guestId: "g1", clt: "4d", rangM: "812" }),
    );
    expect(res.status).toBe(200);
    // Les colonnes d'OVERRIDE, jamais celles du rapprochement : un classement forcé ne doit
    // pas se faire passer pour une donnée squashnet, que le prochain run écraserait.
    expect(h.updated).toEqual({ cltOverride: "4D", rangMOverride: 812 });
  });

  it("efface la correction d'un invité avec des chaînes vides", async () => {
    const res = await POST(post({ action: "set_guest_ranking", guestId: "g1", clt: "", rangM: "" }));
    expect(res.status).toBe(200);
    expect(h.updated).toEqual({ cltOverride: null, rangMOverride: null });
  });

  it("refuse un classement mal formé à la correction", async () => {
    const res = await POST(post({ action: "set_guest_ranking", guestId: "g1", clt: "??" }));
    expect(res.status).toBe(400);
    expect(h.updated).toBeNull();
  });

  it("refuse un rang mixte mal formé, sans rien écrire", async () => {
    const res = await POST(
      post({ action: "set_guest_ranking", guestId: "g1", clt: "5A", rangM: "0" }),
    );
    expect(res.status).toBe(400);
    expect(h.updated).toBeNull();
  });

  it("404 en corrigeant le classement d'un invité qui n'existe pas", async () => {
    h.updatedCount = 0;
    expect(
      (await POST(post({ action: "set_guest_ranking", guestId: "gX", clt: "5A" }))).status,
    ).toBe(404);
  });

  it("re-rapproche un invité à la demande, et rapporte le verdict", async () => {
    // Sert juste après avoir corrigé une orthographe : le cron mensuel y arriverait, mais pas
    // avant le prochain jeudi de championnat.
    const res = await POST(post({ action: "rematch_guest", guestId: "g1" }));
    expect(res.status).toBe(200);
    expect(h.matchGuestRanking).toHaveBeenCalledWith(
      expect.objectContaining({ id: "g1", name: "Paul Hors-Appli" }),
    );
    expect((await res.json()).status).toBe("matched");
  });

  it("404 en re-rapprochant un invité qui n'existe pas", async () => {
    const res = await POST(post({ action: "rematch_guest", guestId: "gX" }));
    expect(res.status).toBe(404);
    expect(h.matchGuestRanking).not.toHaveBeenCalled();
  });

  it("retire un joueur du roster", async () => {
    const res = await POST(post({ action: "remove_guest", guestId: "g1" }));
    expect(res.status).toBe(200);
  });

  it("404 en retirant un joueur qui n'existe pas", async () => {
    h.deleted = 0;
    expect((await POST(post({ action: "remove_guest", guestId: "gX" }))).status).toBe(404);
  });

  it("refuse une action inconnue", async () => {
    expect((await POST(post({ action: "fill" }))).status).toBe(400);
  });
});

// LE CAPITAINE — une désignation, pas un droit.
//
// Il ne peut rien que les autres ne puissent : composer reste ouvert à tout membre, et
// verrouiller créerait un point de blocage le soir où le capitaine n'est pas là. Ce qu'il
// apporte est ailleurs : l'équipe sait à qui parler, et lui seul reçoit le récapitulatif des
// disponibilités et les alertes de calendrier.
describe("POST set_captain", () => {
  it("nomme un membre de l'équipe", async () => {
    h.user = { teamId: "t1", displayName: "Thomas", nickname: null };
    const res = await POST(post({ action: "set_captain", teamId: "t1", userId: "u1" }));
    expect(res.status).toBe(200);
    expect(h.teamUpdated).toMatchObject({ where: { id: "t1" }, data: { captainId: "u1" } });
  });

  it("REFUSE un membre qui n'est pas dans cette équipe", async () => {
    // Nommer quelqu'un d'extérieur est presque toujours une faute de saisie, et le laisser
    // passer donnerait un destinataire d'alertes qui ne se sent pas concerné — donc des
    // alertes que personne ne traite.
    h.user = { teamId: "t2", displayName: "Autre", nickname: null };
    const res = await POST(post({ action: "set_captain", teamId: "t1", userId: "u9" }));
    expect(res.status).toBe(400);
    expect(h.teamUpdated).toBeNull();
  });

  it("404 sur un membre inconnu", async () => {
    h.user = null;
    expect((await POST(post({ action: "set_captain", teamId: "t1", userId: "u9" }))).status).toBe(404);
    expect(h.teamUpdated).toBeNull();
  });

  it("retire le capitaine avec un userId vide", async () => {
    const res = await POST(post({ action: "set_captain", teamId: "t1", userId: "" }));
    expect(res.status).toBe(200);
    expect(h.teamUpdated?.data).toMatchObject({ captainId: null });
  });

  it("403 si l'appelant n'est pas admin", async () => {
    h.admin = null;
    expect((await POST(post({ action: "set_captain", teamId: "t1", userId: "u1" }))).status).toBe(403);
  });
});

// L'ANCRAGE FÉDÉRAL — de quel championnat cette équipe joue le calendrier.
describe("POST set_squashnet_event", () => {
  // L'ancrage réel de l'équipe 1 sur le critérium 2025-2026, poule IVD (Hommes 4).
  const EVENT = "879981be57df0005cac674dce4378296";
  const POULE = "370138";
  const EQUIPE = "161092";
  const ancrage = (over: Record<string, unknown> = {}) => ({
    action: "set_squashnet_event",
    teamId: "t1",
    eventId: EVENT,
    roundId: POULE,
    snTeamId: EQUIPE,
    ...over,
  });

  it("enregistre les TROIS identifiants", async () => {
    const res = await POST(post(ancrage()));
    expect(res.status).toBe(200);
    expect(h.teamUpdated?.data).toMatchObject({
      snEventId: EVENT,
      snRoundId: POULE,
      snTeamId: EQUIPE,
    });
  });

  it("efface l'empreinte en changeant d'ancrage", async () => {
    // La garder ferait passer le premier contrôle du NOUVEAU championnat pour « rien n'a
    // bougé », et l'écart resterait invisible jusqu'à la saison suivante.
    await POST(post(ancrage()));
    expect(h.teamUpdated?.data).toMatchObject({ snCalendarHash: null, snCheckedAt: null });
  });

  it("REFUSE un ancrage incomplet, quelle que soit la pièce qui manque", async () => {
    // Les trois sont nécessaires : l'épreuve dit quoi télécharger, la POULE laquelle des
    // plusieurs qu'elle contient, l'équipe lesquelles des rencontres rendues sont les nôtres.
    //
    // ⚠️ La poule est la pièce dont l'absence coûte le plus cher, parce qu'elle ne provoque
    // AUCUNE erreur : squashnet rend alors une poule au hasard, `ownFixtures` n'y trouve pas
    // notre équipe, et l'import annonce zéro rencontre — ce qui ressemble à une ligue qui n'a
    // rien publié. Deux champs sur trois donneraient l'impression d'être configuré.
    for (const manquant of ["eventId", "roundId", "snTeamId"] as const) {
      const corps = ancrage({ [manquant]: undefined });
      delete (corps as Record<string, unknown>)[manquant];
      expect((await POST(post(corps))).status).toBe(400);
    }
    expect(h.teamUpdated).toBeNull();
  });

  it("refuse des identifiants malformés", async () => {
    // Les contrôler ici évite un import qui échoue plus tard sans qu'on sache lequel des trois
    // champs était fautif.
    expect((await POST(post(ancrage({ eventId: "pas-un-hash" })))).status).toBe(400);
    expect((await POST(post(ancrage({ snTeamId: "abc" })))).status).toBe(400);
    expect((await POST(post(ancrage({ roundId: "poule-IVD" })))).status).toBe(400);
    expect(h.teamUpdated).toBeNull();
  });

  it("accepte de tout effacer avec trois champs vides", async () => {
    const res = await POST(post(ancrage({ eventId: "", roundId: "", snTeamId: "" })));
    expect(res.status).toBe(200);
    expect(h.teamUpdated?.data).toMatchObject({
      snEventId: null,
      snRoundId: null,
      snTeamId: null,
    });
  });

  it("404 quand l'interclub est coupé", async () => {
    h.interclub = false;
    expect(
      (await POST(post({ action: "set_squashnet_event", teamId: "t1", eventId: EVENT, snTeamId: "1" }))).status,
    ).toBe(404);
  });
});
