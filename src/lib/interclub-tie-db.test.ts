import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TeamTie } from "./squashnet/roster";

// ============================================================================
//  POSER LE `tieid` SUR NOS RENCONTRES — le rapprochement qui ouvre la feuille
//  officielle.
//
//  UNE SEULE DÉCISION Y EST PRISE, ET ELLE EST DÉLICATE : sur quelle clé
//  rapprocher notre rencontre et celle de la fiche fédérale. Ni le tour ni
//  l'adversaire ne peuvent servir — une équipe joue DEUX phases renumérotées
//  chacune depuis 1, les tours ne suivent pas l'ordre des dates, et le même
//  adversaire revient à l'aller et au retour. Reste la date, et encore : pas
//  quand elle en désigne deux.
//
//  Se tromper ici ne produit aucune erreur. Ça produit une confrontation avec
//  la feuille d'UNE AUTRE RENCONTRE : des noms crédibles, un score plausible, et
//  une liste d'écarts entièrement fausse.
// ============================================================================

const raw = {
  interclubTeam: { findUnique: vi.fn() },
  interclub: { findMany: vi.fn(), update: vi.fn() },
  squashnetTeamRoster: { findUnique: vi.fn() },
};
vi.mock("./db", () => ({ prisma: raw }));

const refreshRosters = vi.fn();
const loadRosters = vi.fn();
vi.mock("./interclub-roster-db", () => ({
  refreshRosters: (...a: unknown[]) => refreshRosters(...a),
  loadRosters: (...a: unknown[]) => loadRosters(...a),
}));

const fetchTieSheet = vi.fn();
vi.mock("./squashnet/tie", async () => {
  const reel = await vi.importActual<typeof import("./squashnet/tie")>("./squashnet/tie");
  return { ...reel, fetchTieSheet: (id: string) => fetchTieSheet(id) };
});

const { refreshOwnTieIds, readTieSheet, teamCode } = await import("./interclub-tie-db");
const { TieUnreadableError } = await import("./squashnet/tie");

/** Une rencontre de la fiche fédérale, réduite à ce que le rapprochement regarde. */
const tie = (snTieId: string, date: string, over: Partial<TeamTie> = {}): TeamTie => ({
  snTieId,
  date,
  time: "20:00",
  round: "1",
  opponentTeamId: "999",
  opponentName: "Verrieres 3",
  venue: "Verrieres",
  result: "won",
  scoreFor: 4,
  scoreAgainst: 1,
  ...over,
});

/** Le roster de NOTRE équipe, tel que `loadRosters` le rend. */
const roster = (ties: TeamTie[]) => ({
  snTeamId: "42",
  teamName: "Yvette 1",
  code: "YVET1",
  club: "Squash de l yvette",
  captain: null,
  players: [],
  ties,
});

beforeEach(() => {
  raw.interclubTeam.findUnique.mockReset().mockResolvedValue({ snTeamId: "42" });
  raw.interclub.findMany.mockReset().mockResolvedValue([]);
  raw.interclub.update.mockReset().mockResolvedValue({});
  raw.squashnetTeamRoster.findUnique.mockReset().mockResolvedValue(null);
  refreshRosters.mockReset().mockResolvedValue([]);
  loadRosters.mockReset().mockResolvedValue(new Map());
  fetchTieSheet.mockReset();
});

describe("refreshOwnTieIds — le rapprochement sur la date", () => {
  it("pose l'identifiant sur la rencontre du même jour", async () => {
    raw.interclub.findMany.mockResolvedValue([{ id: "f1", date: "2025-10-09", snTieId: null }]);
    loadRosters.mockResolvedValue(new Map([["42", roster([tie("1643001", "2025-10-09")])]]));

    const r = await refreshOwnTieIds("t1");
    expect(r).toMatchObject({ status: "posed", posed: 1, missing: 0 });
    expect(raw.interclub.update).toHaveBeenCalledWith({
      where: { id: "f1" },
      data: { snTieId: "1643001" },
    });
  });

  it("⚠️ NE POSE RIEN quand deux rencontres fédérales tombent le même jour", async () => {
    // C'est le cas des journées d'EXEMPTION : la fiche de référence en porte deux, le même jour.
    // En poser une au hasard ferait confronter notre relevé à la feuille d'une autre rencontre,
    // et tous les écarts affichés seraient faux — sans qu'aucune erreur ne le signale.
    raw.interclub.findMany.mockResolvedValue([{ id: "f1", date: "2026-06-28", snTieId: null }]);
    loadRosters.mockResolvedValue(
      new Map([["42", roster([tie("1", "2026-06-28"), tie("2", "2026-06-28")])]]),
    );

    const r = await refreshOwnTieIds("t1");
    expect(raw.interclub.update).not.toHaveBeenCalled();
    expect(r).toMatchObject({ posed: 0, missing: 1 });
  });

  it("⚠️ le TOUR n'entre pas dans la clé — il se répète d'une phase à l'autre", async () => {
    // Deux « Tour 1 » à huit mois d'écart (championnat puis phase finale). Rapprocher sur le
    // tour irait chercher la feuille de l'autre.
    raw.interclub.findMany.mockResolvedValue([
      { id: "f1", date: "2025-10-09", snTieId: null },
      { id: "f2", date: "2026-05-21", snTieId: null },
    ]);
    loadRosters.mockResolvedValue(
      new Map([
        [
          "42",
          roster([
            tie("1643001", "2025-10-09", { round: "1" }),
            tie("1809918", "2026-05-21", { round: "1" }),
          ]),
        ],
      ]),
    );

    await refreshOwnTieIds("t1");
    expect(raw.interclub.update.mock.calls.map((c) => c[0])).toEqual([
      { where: { id: "f1" }, data: { snTieId: "1643001" } },
      { where: { id: "f2" }, data: { snTieId: "1809918" } },
    ]);
  });

  it("ne redemande rien quand toutes les rencontres en portent déjà un", async () => {
    // Le calendrier d'une équipe ne bouge pas d'un jour à l'autre : une passe qui n'a rien à
    // faire ne doit pas coûter une requête fédérale.
    raw.interclub.findMany.mockResolvedValue([{ id: "f1", date: "2025-10-09", snTieId: "1643001" }]);
    const r = await refreshOwnTieIds("t1");
    expect(r.status).toBe("complete");
    expect(refreshRosters).not.toHaveBeenCalled();
  });

  it("NE REMPLACE PAS un identifiant déjà posé, sauf `force`", async () => {
    // Un report déplace la date des DEUX côtés : l'ancien rapprochement reste valable, et le
    // refaire ne ferait que le réexposer à l'ambiguïté qu'on vient d'écarter.
    raw.interclub.findMany.mockResolvedValue([{ id: "f1", date: "2025-10-09", snTieId: "ancien" }]);
    loadRosters.mockResolvedValue(new Map([["42", roster([tie("nouveau", "2025-10-09")])]]));

    await refreshOwnTieIds("t1");
    expect(raw.interclub.update).not.toHaveBeenCalled();

    await refreshOwnTieIds("t1", { force: true });
    expect(raw.interclub.update).toHaveBeenCalledWith({
      where: { id: "f1" },
      data: { snTieId: "nouveau" },
    });
  });

  it("⚠️ « équipe non ancrée » ne se confond pas avec « fiche illisible »", async () => {
    // Le premier est un défaut de CONFIGURATION (Admin › Interclub), le second une panne
    // passagère. Les afficher pareil enverrait réessayer une lecture qui n'a pas de cible.
    raw.interclubTeam.findUnique.mockResolvedValue({ snTeamId: null });
    expect((await refreshOwnTieIds("t1")).status).toBe("noTeamId");

    raw.interclubTeam.findUnique.mockResolvedValue({ snTeamId: "42" });
    raw.interclub.findMany.mockResolvedValue([{ id: "f1", date: "2025-10-09", snTieId: null }]);
    loadRosters.mockResolvedValue(new Map()); // rien en cache, rien téléchargé
    expect((await refreshOwnTieIds("t1")).status).toBe("unread");
  });

  it("n'invente pas d'identifiant pour une rencontre que la ligue ne connaît pas", async () => {
    // Une rencontre saisie à la main, ou déplacée hors calendrier fédéral. Elle reste sans
    // feuille — ce qui se dit, et ne se devine pas.
    raw.interclub.findMany.mockResolvedValue([{ id: "f1", date: "2026-01-01", snTieId: null }]);
    loadRosters.mockResolvedValue(new Map([["42", roster([tie("1643001", "2025-10-09")])]]));

    const r = await refreshOwnTieIds("t1");
    expect(raw.interclub.update).not.toHaveBeenCalled();
    expect(r.missing).toBe(1);
  });

  it("va lire la fiche de NOTRE équipe, et d'elle seule", async () => {
    raw.interclub.findMany.mockResolvedValue([{ id: "f1", date: "2025-10-09", snTieId: null }]);
    loadRosters.mockResolvedValue(new Map([["42", roster([tie("1643001", "2025-10-09")])]]));
    await refreshOwnTieIds("t1");
    expect(refreshRosters).toHaveBeenCalledWith(["42"]);
  });
});

describe("readTieSheet — ne jette jamais, et dit pourquoi", () => {
  it("rend la feuille quand tout va bien", async () => {
    fetchTieSheet.mockResolvedValue({ snTieId: "1" });
    expect(await readTieSheet("1")).toEqual({ sheet: { snTieId: "1" }, error: null });
  });

  it("⚠️ distingue « rendu changé » de « pas de réponse »", async () => {
    // Le premier appelle une recapture de fixture, le second d'attendre. Les confondre envoie
    // chercher un bug qui n'existe pas.
    fetchTieSheet.mockRejectedValue(new TieUnreadableError("1", "essai"));
    expect(await readTieSheet("1")).toEqual({ sheet: null, error: "unreadable" });

    fetchTieSheet.mockRejectedValue(new Error("ECONNRESET"));
    expect(await readTieSheet("1")).toEqual({ sheet: null, error: "failed" });
  });
});

describe("teamCode", () => {
  it("rend le sigle en cache, et null quand on ne l'a pas — jamais deviné", async () => {
    raw.squashnetTeamRoster.findUnique.mockResolvedValue({ code: "VERR2" });
    expect(await teamCode("161095")).toBe("VERR2");

    raw.squashnetTeamRoster.findUnique.mockResolvedValue(null);
    expect(await teamCode("161095")).toBeNull();
    // Sans identifiant, on ne va même pas regarder.
    expect(await teamCode(null)).toBeNull();
  });
});
