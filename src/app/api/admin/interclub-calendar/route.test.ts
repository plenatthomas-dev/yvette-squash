import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// L'IMPORT DU CALENDRIER FÉDÉRAL — ce qu'il écrit, et surtout ce qu'il refuse d'écrire.
//
// Deux règles ne se voient pas à la relecture et ne tiennent qu'ici :
//
//  1. UNE RENCONTRE DÉJÀ COMMENCÉE NE SE DÉPLACE PLUS. Le `PATCH` le refuse depuis toujours
//     (409) ; l'import ne l'a pas refusé pendant un temps, si bien que le chemin AUTOMATIQUE —
//     celui que personne ne regarde — était moins prudent que le chemin humain. Déplacer une
//     soirée déjà jouée effacerait au passage les réponses recueillies pour elle.
//  2. UNE JOURNÉE RETIRÉE DU CALENDRIER SE SIGNALE, ELLE NE SE SUPPRIME PAS. Elle porte
//     peut-être une composition et des réponses, et « plus rien n'est publié » peut n'être
//     qu'un scraping qui a cassé.

const h = vi.hoisted(() => ({
  team: null as null | Record<string, unknown>,
  fixtures: [] as Array<Record<string, unknown>>,
  published: [] as Array<Record<string, unknown>>,
  fetchThrows: false,
  created: [] as Array<Record<string, unknown>>,
  updated: [] as Array<{ id: string; data: Record<string, unknown> }>,
  wipedFor: [] as string[],
  moved: [] as Array<[unknown, string, unknown]>,
  standings: [] as Array<Record<string, unknown>>,
  standingsThrows: false,
  teamUpdates: [] as Array<Record<string, unknown>>,
  /** La fonction interclub est-elle allumée ? (404 avant toute chose si elle ne l'est pas.) */
  interclub: true,
  /** L'appelant est-il admin ? Les doubles inconditionnels rendaient les deux premières
      gardes du fichier intestables — celles qui décident QUI peut écrire un calendrier. */
  admin: { userId: "adm", email: "a@ex.com" } as null | { userId: string; email: string },
}));

vi.mock("@/lib/interclub-access", async () => {
  const { NextResponse } = await import("next/server");
  return {
    interclubDisabledResponse: async () =>
      h.interclub ? null : NextResponse.json({ error: "Fonction indisponible" }, { status: 404 }),
  };
});
vi.mock("@/lib/admin", () => ({ requireAdmin: async () => h.admin }));
vi.mock("@/lib/interclub-gate", () => ({ interclubChanged: vi.fn() }));
vi.mock("@/lib/interclub-notify", () => ({
  notifyFixtureMoved: vi.fn(async (...args: [unknown, string, unknown]) => {
    h.moved.push(args);
  }),
}));

// Le RÉSEAU seul est simulé : `ownFixtures`, `diffCalendar` et `matchKey` restent les vrais,
// sinon ce fichier vérifierait un double de la règle et non la règle.
vi.mock("@/lib/squashnet/calendar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/squashnet/calendar")>()),
  fetchTeamCalendar: vi.fn(async () => {
    if (h.fetchThrows) throw new Error("réseau");
    return [];
  }),
  ownFixtures: vi.fn(() => h.published),
}));

vi.mock("@/lib/squashnet/standings", () => ({
  fetchStandings: vi.fn(async () => {
    if (h.standingsThrows) throw new Error("réseau");
    return h.standings;
  }),
}));

vi.mock("@/lib/db", () => {
  const prisma: Record<string, unknown> = {
    interclubTeam: {
      findUnique: vi.fn(async () => h.team),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        h.teamUpdates.push(args.data);
        return {};
      }),
    },
    interclub: {
      findMany: vi.fn(async () => h.fixtures),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        h.created.push(args.data);
        return args.data;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        h.updated.push({ id: args.where.id, data: args.data });
        return args.data;
      }),
    },
    interclubAvailability: {
      deleteMany: vi.fn(async (args: { where: { interclubId: string } }) => {
        h.wipedFor.push(args.where.interclubId);
        return { count: 1 };
      }),
    },
  };
  prisma.$transaction = async (run: (tx: unknown) => Promise<unknown>) => run(prisma);
  return { prisma };
});

import { POST } from "./route";

const EVENT = "ev1";
const req = (body: unknown) => ({ json: async () => body }) as unknown as NextRequest;

/** Une rencontre telle que la ligue la publie. */
const publiee = (over: Record<string, unknown> = {}) => ({
  round: "J1",
  date: "2026-10-09",
  time: "20:00",
  home: true,
  opponent: "Montmartre 1",
  venue: "SQUASH DE L YVETTE",
  venueAddress: "1 RUE DU SQUASH",
  dateConfirmed: true,
  ...over,
});

/** Une rencontre en base, importée de cet événement, jamais commencée. */
const enBase = (over: Record<string, unknown> = {}) => ({
  id: "f1",
  round: "J1",
  date: "2026-10-09",
  time: "20:00",
  home: true,
  opponent: "Montmartre 1",
  venue: "SQUASH DE L YVETTE",
  venueAddress: "1 RUE DU SQUASH",
  dateConfirmed: true,
  snMatchKey: `${EVENT}:J1`,
  matchCount: 4,
  // `gamesHome: null` et non 0 : `derivedStatus` traite TOUT score écrit — zéro compris —
  // comme une soirée entamée. Un 0 ici aurait fait passer la rencontre pour commencée.
  matches: [{ gamesHome: null, status: "pending" }],
  ...over,
});

/** Les mêmes, mais la soirée a commencé : un jeu est joué. */
const commencee = (over: Record<string, unknown> = {}) =>
  enBase({ matches: [{ gamesHome: 2, status: "done" }], ...over });

beforeEach(() => {
  h.team = {
    id: "t1",
    name: "Équipe 1",
    snEventId: EVENT,
    snRoundId: "370138",
    snDrawId: "47760",
    snTeamId: "161092",
    captainId: "c1",
  };
  h.fixtures = [];
  h.published = [];
  h.fetchThrows = false;
  h.created = [];
  h.updated = [];
  h.wipedFor = [];
  h.moved = [];
  h.standings = [{ rank: 1, name: "Squash de l'Yvette", snTeamId: "161092", points: 9 }];
  h.standingsThrows = false;
  h.teamUpdates = [];
  h.interclub = true;
  h.admin = { userId: "adm", email: "a@ex.com" };
});

describe("préambule", () => {
  it("404 quand la fonction interclub est coupée, AVANT de regarder les droits", async () => {
    // La première garde du fichier, et elle passait entre les mailles : le double la rendait
    // toujours ouverte. Le 404 précède le 403 partout dans ce dépôt — on ne dit pas « réservé
    // aux admins » d'une fonction qui n'existe pas.
    h.interclub = false;
    h.admin = null;
    expect((await POST(req({ action: "preview", teamId: "t1" }))).status).toBe(404);
  });

  it("403 pour qui n'est pas admin — un import écrit le calendrier de tout le club", async () => {
    h.admin = null;
    const res = await POST(req({ action: "apply", teamId: "t1" }));
    expect(res.status).toBe(403);
    expect(h.created).toEqual([]);
    expect(h.updated).toEqual([]);
  });

  it("refuse une action inconnue", async () => {
    expect((await POST(req({ action: "drop", teamId: "t1" }))).status).toBe(400);
  });

  it("dit qu'une équipe SANS ancrage ne peut pas importer, plutôt que d'importer zéro rencontre", async () => {
    // « 0 rencontre trouvée » enverrait chercher la panne du côté de la fédération alors que la
    // configuration manque ici.
    h.team = {
      id: "t1",
      name: "Équipe 1",
      snEventId: null,
      snRoundId: null,
      snTeamId: null,
      captainId: null,
    };
    const res = await POST(req({ action: "preview", teamId: "t1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/pas rattachée/i);
  });

  it("refuse d'importer sans la POULE, même avec épreuve et équipe", async () => {
    // C'est le cas qui ne se voit pas : sans `roundid`, squashnet rend une poule au hasard,
    // `ownFixtures` n'y trouve pas notre équipe, et l'import annonce zéro rencontre sans la
    // moindre erreur. On préfère refuser en le disant.
    h.team = { ...(h.team as Record<string, unknown>), snRoundId: null };
    const res = await POST(req({ action: "preview", teamId: "t1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/pas rattachée/i);
  });

  it("un hoquet réseau se DIT, il ne passe pas pour un calendrier vide", async () => {
    h.fetchThrows = true;
    expect((await POST(req({ action: "preview", teamId: "t1" }))).status).toBe(502);
  });
});

describe("prévisualisation", () => {
  it("n'écrit RIEN — c'est tout l'intérêt du premier temps", async () => {
    h.published = [publiee()];
    await POST(req({ action: "preview", teamId: "t1" }));
    expect(h.created).toEqual([]);
    expect(h.updated).toEqual([]);
  });

  it("annonce une journée que la ligue NE PUBLIE PLUS", async () => {
    h.fixtures = [enBase({ id: "x", round: "J7", snMatchKey: `${EVENT}:J7` })];
    h.published = [publiee()];
    const body = await (await POST(req({ action: "preview", teamId: "t1" }))).json();
    expect(body.toDelete).toEqual([
      { id: "x", round: "J7", date: "2026-10-09", opponent: "Montmartre 1" },
    ]);
  });

  it("prévient qu'une rencontre COMMENCÉE gardera sa date", async () => {
    h.fixtures = [commencee()];
    h.published = [publiee({ date: "2026-10-16" })];
    const body = await (await POST(req({ action: "preview", teamId: "t1" }))).json();
    expect(body.frozen).toEqual(["J1"]);
  });

  it("SIGNALE un statut de date qui diverge, sans le mettre dans les corrections", async () => {
    // L'admin a corrigé à la main une J1 que la déduction croyait prévisionnelle. La
    // prévisualisation doit le dire — sinon l'écart n'atteint personne — mais l'annoncer comme
    // une correction à appliquer serait annoncer qu'on va révoquer sa correction.
    h.fixtures = [enBase({ dateConfirmed: false })];
    h.published = [publiee()];
    const body = await (await POST(req({ action: "preview", teamId: "t1" }))).json();
    expect(body.confirmDrift).toEqual([{ id: "f1", round: "J1", stored: false, published: true }]);
    expect(body.toUpdate).toEqual([]);
  });

  it("ne gèle rien quand la rencontre n'a pas commencé", async () => {
    h.fixtures = [enBase()];
    h.published = [publiee({ date: "2026-10-16" })];
    const body = await (await POST(req({ action: "preview", teamId: "t1" }))).json();
    expect(body.frozen).toEqual([]);
  });
});

describe("application", () => {
  it("crée une journée publiée qu'on n'avait pas, avec ses simples « à désigner »", async () => {
    h.published = [publiee()];
    await POST(req({ action: "apply", teamId: "t1" }));
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ round: "J1", date: "2026-10-09", snMatchKey: `${EVENT}:J1` });
  });

  it("DÉPLACE une rencontre non commencée, efface ses réponses et prévient l'équipe", async () => {
    h.fixtures = [enBase()];
    h.published = [publiee({ date: "2026-10-16" })];
    await POST(req({ action: "apply", teamId: "t1" }));

    expect(h.updated[0].data).toMatchObject({ date: "2026-10-16", availabilityOpenedAt: null });
    expect(h.wipedFor).toEqual(["f1"]);
    expect(h.moved).toHaveLength(1);
  });

  it("NE DÉPLACE PAS une rencontre commencée, et ne touche pas à ses réponses", async () => {
    // La garde qui manquait. Sans elle, l'import réécrivait la date d'une soirée déjà jouée et
    // effaçait au passage les réponses qu'elle portait.
    h.fixtures = [commencee()];
    h.published = [publiee({ date: "2026-10-16" })];
    await POST(req({ action: "apply", teamId: "t1" }));

    expect(h.updated[0].data).not.toHaveProperty("date");
    expect(h.wipedFor).toEqual([]);
    expect(h.moved).toEqual([]);
  });

  it("applique quand même le LIEU d'une rencontre commencée — seule la date a des conséquences", async () => {
    h.fixtures = [commencee()];
    h.published = [publiee({ venue: "SQUASH DE MASSY" })];
    await POST(req({ action: "apply", teamId: "t1" }));
    expect(h.updated[0].data).toMatchObject({ venue: "SQUASH DE MASSY" });
  });

  it("NE RÉVOQUE JAMAIS la correction manuelle du statut de la date", async () => {
    // LE DÉFAUT LE PLUS GRAVE DE LA BRANCHE, et il était silencieux. La ligue programme deux
    // journées le même soir, la déduction les classe prévisionnelles, l'appel de disponibilité
    // se tait ; l'admin corrige les deux à la main et l'appel repart. Trois semaines plus tard
    // la ligue corrige le LIEU d'une autre journée, l'admin clique « Appliquer » — et les deux
    // repassaient à « prévisionnelle » : l'équipe cessait d'être convoquée, sans un mot.
    h.fixtures = [enBase({ dateConfirmed: false })];
    h.published = [publiee({ venue: "SQUASH DE MASSY" })];
    await POST(req({ action: "apply", teamId: "t1" }));
    expect(h.updated[0].data).toMatchObject({ venue: "SQUASH DE MASSY" });
    expect(h.updated[0].data).not.toHaveProperty("dateConfirmed");
  });

  it("pose en revanche la déduction sur une rencontre qu'il DÉCOUVRE", async () => {
    // Le pendant : il n'y a là aucune correction humaine à préserver, et une date bouchon doit
    // naître prévisionnelle sous peine de convoquer l'équipe un 30 juin.
    h.published = [publiee({ dateConfirmed: false })];
    await POST(req({ action: "apply", teamId: "t1" }));
    expect(h.created[0]).toMatchObject({ dateConfirmed: false });
  });

  it("REFUSE d'appliquer un aperçu périmé, au lieu d'écrire autre chose", async () => {
    // Les deux temps ne tenaient l'un à l'autre par rien : `apply` retélécharge et recalcule.
    // L'admin qui prévisualise, s'absente et revient cliquer validait donc un écart qu'il
    // n'avait jamais lu — un déplacement de date efface au passage les disponibilités.
    h.published = [publiee()];
    const res = await POST(req({ action: "apply", teamId: "t1", seen: "un aperçu d'hier" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("stale_preview");
    expect(h.created).toEqual([]);
    expect(h.updated).toEqual([]);
  });

  it("applique quand l'aperçu est celui du calendrier publié", async () => {
    h.published = [publiee()];
    const vu = (await (await POST(req({ action: "preview", teamId: "t1" }))).json()).seen;
    expect(typeof vu).toBe("string");
    const res = await POST(req({ action: "apply", teamId: "t1", seen: vu }));
    expect(res.status).toBe(200);
    expect(h.created).toHaveLength(1);
  });

  it("applique encore sans `seen` — un vieux client ne doit pas rester bloqué", async () => {
    h.published = [publiee()];
    expect((await POST(req({ action: "apply", teamId: "t1" }))).status).toBe(200);
    expect(h.created).toHaveLength(1);
  });

  it("ne SUPPRIME jamais une journée retirée du calendrier, il la compte", async () => {
    h.fixtures = [enBase({ id: "x", round: "J7", snMatchKey: `${EVENT}:J7` })];
    h.published = [publiee()];
    const body = await (await POST(req({ action: "apply", teamId: "t1" }))).json();
    expect(body.vanished).toBe(1);
    expect(h.updated).toEqual([]); // rien touché sur elle
  });

  it("NE TOUCHE PAS une rencontre saisie à la main, même sur la même journée", async () => {
    h.fixtures = [enBase({ snMatchKey: null })];
    h.published = [publiee({ date: "2026-10-16" })];
    await POST(req({ action: "apply", teamId: "t1" }));
    expect(h.updated).toEqual([]);
    expect(h.created).toHaveLength(1); // son homologue fédérale est créée à côté
  });
});

describe("classement — la lecture à la demande", () => {
  it("télécharge et enregistre le classement de la poule", async () => {
    const res = await POST(req({ action: "standings", teamId: "t1" }));
    expect(res.status).toBe(200);
    expect((await res.json()).rows).toBe(1);
    const ecrit = h.teamUpdates.at(-1);
    expect(JSON.parse(ecrit?.snStandingsJson as string)).toEqual(h.standings);
    expect(ecrit?.snStandingsAt).toBeInstanceOf(Date);
  });

  it("REFUSE sans la division, plutôt que de rendre une autre poule", async () => {
    // Sans `drawid`, la fédération ignore `roundid` et rend la division 1 : huit équipes,
    // dix-huit colonnes, un tableau parfaitement crédible où l'Yvette ne figure pas. C'est
    // exactement le genre de résultat qu'on afficherait sans se poser de question.
    h.team = { ...(h.team as Record<string, unknown>), snDrawId: null };
    const res = await POST(req({ action: "standings", teamId: "t1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/division/i);
    expect(h.teamUpdates).toHaveLength(0);
  });

  it("un classement VIDE n'écrase pas celui qu'on a", async () => {
    // Zéro ligne n'est pas « la poule est vide » : c'est une poule non publiée, ou un ancrage
    // faux. L'écrire remplacerait un tableau valide par du vide, en silence.
    h.standings = [];
    const res = await POST(req({ action: "standings", teamId: "t1" }));
    expect(res.status).toBe(404);
    expect(h.teamUpdates).toHaveLength(0);
  });

  it("un hoquet réseau se DIT, il ne vide rien", async () => {
    h.standingsThrows = true;
    const res = await POST(req({ action: "standings", teamId: "t1" }));
    expect(res.status).toBe(502);
    expect(h.teamUpdates).toHaveLength(0);
  });

  it("refuse une équipe sans ancrage, comme l'import", async () => {
    h.team = { ...(h.team as Record<string, unknown>), snEventId: null };
    expect((await POST(req({ action: "standings", teamId: "t1" }))).status).toBe(400);
  });
});
