import { describe, it, expect, vi, beforeEach } from "vitest";
import { RosterUnreadableError, type TeamRoster } from "./squashnet/roster";

// ============================================================================
//  LE CACHE DES ROSTERS — quand on redemande, et surtout quand on NE redemande
//  PAS. Trois décisions y sont tenues, et chacune a un coût si elle lâche :
//  le débit qu'on impose à un site associatif, un roster écrasé par un silence,
//  et deux échecs qu'on confondrait.
// ============================================================================

const fetchTeamRoster = vi.fn();
vi.mock("./squashnet/roster", async () => {
  const reel = await vi.importActual<typeof import("./squashnet/roster")>("./squashnet/roster");
  return { ...reel, fetchTeamRoster: (id: string) => fetchTeamRoster(id) };
});

// Le double de base, casté comme ailleurs dans le dépôt (cf. `captain-access.test.ts`) : les
// signatures surchargées de Prisma ne se laissent pas imiter par un `vi.fn()`, et les imiter
// n'apprendrait rien de plus sur le code testé.
const raw = {
  squashnetTeamRoster: {
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
};
const db = raw as unknown as Parameters<typeof loadRosters>[1];

const { loadRosters, refreshRosters, ROSTER_FRAIS_JOURS } = await import("./interclub-roster-db");

const roster = (snTeamId: string, noms: string[]): TeamRoster => ({
  snTeamId,
  // Aucune rencontre : ces bancs d'essai portent sur les JOUEURS, pas sur le calendrier.
  ties: [],
  teamName: "Verrieres 2",
  code: "VERR2",
  club: "Squash club verrieres le buisson",
  captain: null,
  players: noms.map((name) => ({
    name,
    gender: "Mr.",
    licence: "0100000",
    clt: "5A",
    rang: 2000,
    rangM: 2000,
    registeredAt: "2025-09-22",
  })),
});

const JOUR = 86_400_000;
const MAINTENANT = new Date("2026-09-10T12:00:00.000Z");
const ilYA = (jours: number) => new Date(MAINTENANT.getTime() - jours * JOUR);

beforeEach(() => {
  vi.clearAllMocks();
  raw.squashnetTeamRoster.findMany.mockResolvedValue([]);
  raw.squashnetTeamRoster.upsert.mockResolvedValue({});
});

describe("loadRosters", () => {
  it("ne lit rien et n'interroge personne sans identifiant", async () => {
    expect((await loadRosters([], db)).size).toBe(0);
    expect(raw.squashnetTeamRoster.findMany).not.toHaveBeenCalled();
  });

  it("écarte une ligne dont le JSON n'a plus la forme attendue", async () => {
    // « JSON valide » ne suffit pas : un roster d'un format antérieur passe le `JSON.parse`,
    // puis lève au rendu — où il n'y a pas d'error boundary. Mieux vaut un menu sans classement
    // qu'une vue interclub qui tombe.
    raw.squashnetTeamRoster.findMany.mockResolvedValue([
      { snTeamId: "1", rosterJson: JSON.stringify({ joueurs: ["ancien format"] }) },
      { snTeamId: "2", rosterJson: "pas du json" },
      { snTeamId: "3", rosterJson: JSON.stringify(roster("3", ["DETRY XAVIER"])) },
    ]);
    const map = await loadRosters(["1", "2", "3"], db);
    expect([...map.keys()]).toEqual(["3"]);
  });

  it("NE TÉLÉCHARGE JAMAIS — c'est un chemin où quelqu'un attend devant son écran", async () => {
    await loadRosters(["1"], db);
    expect(fetchTeamRoster).not.toHaveBeenCalled();
  });
});

describe("refreshRosters", () => {
  it("va chercher ce qu'on n'a pas, et le range", async () => {
    fetchTeamRoster.mockResolvedValue(roster("161095", ["DETRY XAVIER", "POPULU AXEL"]));
    const out = await refreshRosters(["161095"], { db, now: MAINTENANT, delaiMs: 0 });
    expect(out).toEqual([{ snTeamId: "161095", status: "fetched", players: 2 }]);
    expect(raw.squashnetTeamRoster.upsert).toHaveBeenCalledOnce();
    // Le nom du CLUB est rangé à côté du nom de l'ÉQUIPE : c'est la distinction qui a coûté le
    // bug des équipes numérotées, et la ligue nous donne les deux.
    const arg = raw.squashnetTeamRoster.upsert.mock.calls[0][0];
    expect(arg.create.club).toBe("Squash club verrieres le buisson");
    expect(arg.create.name).toBe("Verrieres 2");
  });

  it("ne redemande pas un roster récent — le débit qu'on impose est le prix de tout ceci", async () => {
    raw.squashnetTeamRoster.findMany.mockResolvedValue([
      { snTeamId: "161095", fetchedAt: ilYA(1), rosterJson: JSON.stringify(roster("161095", ["A B"])) },
    ]);
    const out = await refreshRosters(["161095"], { db, now: MAINTENANT, delaiMs: 0 });
    expect(out).toEqual([{ snTeamId: "161095", status: "fresh" }]);
    expect(fetchTeamRoster).not.toHaveBeenCalled();
  });

  it("redemande passé le délai de fraîcheur", async () => {
    raw.squashnetTeamRoster.findMany.mockResolvedValue([
      {
        snTeamId: "161095",
        fetchedAt: ilYA(ROSTER_FRAIS_JOURS + 1),
        rosterJson: JSON.stringify(roster("161095", ["A B"])),
      },
    ]);
    fetchTeamRoster.mockResolvedValue(roster("161095", ["A B", "C D"]));
    const out = await refreshRosters(["161095"], { db, now: MAINTENANT, delaiMs: 0 });
    expect(out[0].status).toBe("fetched");
  });

  it("redemande une ligne récente mais ILLISIBLE, au lieu de la figer une semaine", async () => {
    raw.squashnetTeamRoster.findMany.mockResolvedValue([
      { snTeamId: "161095", fetchedAt: ilYA(1), rosterJson: "{}" },
    ]);
    fetchTeamRoster.mockResolvedValue(roster("161095", ["A B"]));
    const out = await refreshRosters(["161095"], { db, now: MAINTENANT, delaiMs: 0 });
    expect(out[0].status).toBe("fetched");
  });

  it("`force` refait tout sans regarder l'âge", async () => {
    raw.squashnetTeamRoster.findMany.mockResolvedValue([
      { snTeamId: "161095", fetchedAt: MAINTENANT, rosterJson: JSON.stringify(roster("161095", ["A B"])) },
    ]);
    fetchTeamRoster.mockResolvedValue(roster("161095", ["A B"]));
    const out = await refreshRosters(["161095"], { db, now: MAINTENANT, delaiMs: 0, force: true });
    expect(out[0].status).toBe("fetched");
  });

  it("N'ÉCRASE PAS un roster existant quand la ligue ne répond pas", async () => {
    // Un roster capté la semaine dernière vaut infiniment mieux que rien. L'écraser par un
    // silence ferait disparaître d'un menu des joueurs parfaitement réels, sans qu'aucune
    // erreur ne l'explique — la panne muette que tout ce module cherche à éviter.
    raw.squashnetTeamRoster.findMany.mockResolvedValue([
      {
        snTeamId: "161095",
        fetchedAt: ilYA(30),
        rosterJson: JSON.stringify(roster("161095", ["DETRY XAVIER"])),
      },
    ]);
    fetchTeamRoster.mockRejectedValue(new Error("ETIMEDOUT"));
    const out = await refreshRosters(["161095"], { db, now: MAINTENANT, delaiMs: 0 });
    expect(out).toEqual([{ snTeamId: "161095", status: "failed" }]);
    expect(raw.squashnetTeamRoster.upsert).not.toHaveBeenCalled();
  });

  it("distingue « illisible » de « sans réponse » — les remèdes n'ont rien à voir", async () => {
    // Illisible = le rendu de squashnet a changé, il faut recapter une fixture. Sans réponse =
    // réessayer plus tard. Les afficher pareil enverrait chercher un bug qui n'existe pas.
    fetchTeamRoster
      .mockRejectedValueOnce(new RosterUnreadableError("1"))
      .mockRejectedValueOnce(new Error("500"));
    const out = await refreshRosters(["1", "2"], { db, now: MAINTENANT, delaiMs: 0 });
    expect(out.map((o) => o.status)).toEqual(["unreadable", "failed"]);
  });

  it("l'échec d'une équipe ne prive pas les autres de leur roster", async () => {
    fetchTeamRoster
      .mockRejectedValueOnce(new Error("500"))
      .mockResolvedValueOnce(roster("2", ["A B"]));
    const out = await refreshRosters(["1", "2"], { db, now: MAINTENANT, delaiMs: 0 });
    expect(out.map((o) => o.status)).toEqual(["failed", "fetched"]);
    expect(raw.squashnetTeamRoster.upsert).toHaveBeenCalledOnce();
  });

  it("dédoublonne : cinq rencontres contre le même club, une seule requête", async () => {
    fetchTeamRoster.mockResolvedValue(roster("161095", ["A B"]));
    await refreshRosters(["161095", "161095", "161095"], { db, now: MAINTENANT, delaiMs: 0 });
    expect(fetchTeamRoster).toHaveBeenCalledOnce();
  });

  it("ne fait rien, et ne lit rien, sans identifiant", async () => {
    expect(await refreshRosters([], { db, now: MAINTENANT })).toEqual([]);
    expect(raw.squashnetTeamRoster.findMany).not.toHaveBeenCalled();
    expect(fetchTeamRoster).not.toHaveBeenCalled();
  });
});
