import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RankingRow } from "./client";

// On mocke la couche réseau (client) et la base (prisma) ; le RAPPROCHEMENT (match.ts) reste
// le vrai code, pour tester le comportement de bout en bout de refreshRankings().
const h = vi.hoisted(() => ({
  members: [] as {
    id: string;
    displayName: string;
    squashnetGivenName?: string | null;
    squashnetFamilyName?: string | null;
  }[],
  /** Le membre que `findUnique` rend à `refreshMemberRanking` (rapprochement d'UN seul). */
  member: null as null | {
    id: string;
    displayName: string;
    squashnetGivenName?: string | null;
    squashnetFamilyName?: string | null;
  },
  findUnique: vi.fn(),
  // Les joueurs SANS COMPTE sont balayés par la même passe : ils partagent la boucle, le
  // verdict et le disjoncteur. Vide par défaut — la plupart des cas ne parlent que des membres.
  guests: [] as { id: string; name: string }[],
  getLatestMonth: vi.fn(),
  searchRanking: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
  findMany: vi.fn(),
  guestFindMany: vi.fn(),
  guestUpdate: vi.fn(),
  guestUpdateMany: vi.fn(),
}));

vi.mock("./client", () => ({
  getLatestMonth: h.getLatestMonth,
  searchRanking: h.searchRanking,
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findMany: h.findMany, findUnique: h.findUnique },
    squashnetRanking: { upsert: h.upsert, deleteMany: h.deleteMany },
    interclubGuest: {
      findMany: h.guestFindMany,
      update: h.guestUpdate,
      updateMany: h.guestUpdateMany,
    },
  },
}));

import { refreshRankings, refreshMemberRanking, summarizeRefresh } from "./refresh";
import type { RefreshResult } from "./refresh";

// Fabrique une ligne squashnet ; club Yvette par défaut (celui que matchRanking cible).
function row(name: string, over: Partial<RankingRow> = {}): RankingRow {
  return {
    name,
    clt: "5A",
    club: "Squash de l yvette",
    licence: "0000001",
    ligue: "IDF",
    cat: "Senior",
    gender: "male",
    rang: "42",
    rangM: "30",
    mean: "1 000",
    ...over,
  };
}

beforeEach(() => {
  h.getLatestMonth.mockReset().mockResolvedValue("2026-07-07");
  h.searchRanking.mockReset();
  h.upsert.mockReset().mockResolvedValue({});
  h.deleteMany.mockReset().mockResolvedValue({ count: 1 });
  // Remis à zéro comme `guests` : sans cela, l'effectif du test précédent débordait sur le
  // suivant et consommait ses `mockResolvedValueOnce`.
  h.members = [];
  h.findMany.mockReset().mockImplementation(async () => h.members);
  h.member = null;
  h.findUnique.mockReset().mockImplementation(async () => h.member);
  h.guests = [];
  h.guestFindMany.mockReset().mockImplementation(async () => h.guests);
  h.guestUpdate.mockReset().mockResolvedValue({});
  h.guestUpdateMany.mockReset().mockResolvedValue({ count: 1 });
});

describe("refreshRankings", () => {
  it("période introuvable → n'interroge ni la base ni squashnet", async () => {
    h.getLatestMonth.mockResolvedValueOnce(null);
    const res = await refreshRankings();
    expect(res).toEqual({
      month: null,
      members: 0,
      guests: 0,
      matched: 0,
      cleared: 0,
      skipped: 0,
      failed: 0,
      bulkMoveBlocked: false,
    });
    expect(h.findMany).not.toHaveBeenCalled();
    expect(h.searchRanking).not.toHaveBeenCalled();
  });

  it("hit unique dans le club → upsert du classement (matched)", async () => {
    h.members = [{ id: "u1", displayName: "Jean Dupont" }];
    h.searchRanking.mockResolvedValueOnce([row("DUPONT JEAN")]);
    const res = await refreshRankings();
    expect(res).toMatchObject({ matched: 1, cleared: 0, skipped: 0 });
    expect(h.upsert).toHaveBeenCalledOnce();
    expect(h.deleteMany).not.toHaveBeenCalled();
  });

  it("membre retrouvé UNIQUEMENT dans un autre club → suppression (moved)", async () => {
    h.members = [{ id: "u1", displayName: "Jean Dupont" }];
    // Son nom colle, mais la seule ligne est ailleurs → il a quitté l'Yvette : signal fiable.
    h.searchRanking.mockResolvedValueOnce([row("DUPONT JEAN", { club: "Squash Club de Rennes" })]);
    const res = await refreshRankings();
    expect(res).toMatchObject({ matched: 0, cleared: 1, skipped: 0 });
    expect(h.deleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("aucune ligne au nom du membre (autres joueurs) → NE supprime PAS (page 2 possible)", async () => {
    h.members = [{ id: "u1", displayName: "Jean Dupont" }];
    // Homonymes de nom de FAMILLE seulement (prénoms différents) : le membre peut être en page 2.
    h.searchRanking.mockResolvedValueOnce([
      row("DUPONT PIERRE", { club: "Autre Club" }),
      row("DUPONT MARC", { club: "Encore Autre" }),
    ]);
    const res = await refreshRankings();
    expect(res).toMatchObject({ matched: 0, cleared: 0, skipped: 1 });
    expect(h.deleteMany).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("homonymes AMBIGUS dans le club → NE supprime NI n'écrit rien (skipped)", async () => {
    h.members = [{ id: "u1", displayName: "Jean Dupont" }];
    // Deux « Jean Dupont » plausibles dans le club → on n'affirme pas et on ne supprime pas.
    h.searchRanking.mockResolvedValueOnce([row("DUPONT JEAN"), row("DUPONT JEAN PIERRE")]);
    const res = await refreshRankings();
    expect(res).toMatchObject({ matched: 0, cleared: 0, skipped: 1 });
    expect(h.deleteMany).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("réponse VIDE → NE supprime PAS (non concluant, skipped)", async () => {
    h.members = [{ id: "u1", displayName: "Jean Dupont" }];
    h.searchRanking.mockResolvedValueOnce([]);
    const res = await refreshRankings();
    expect(res).toMatchObject({ matched: 0, cleared: 0, skipped: 1 });
    expect(h.deleteMany).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("erreur squashnet → n'écrase rien (skipped)", async () => {
    h.members = [{ id: "u1", displayName: "Jean Dupont" }];
    h.searchRanking.mockRejectedValueOnce(new Error("timeout"));
    const res = await refreshRankings();
    expect(res).toMatchObject({ matched: 0, cleared: 0, skipped: 1 });
    expect(h.deleteMany).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("panne base à l'écriture → comptée `failed` (pas `skipped`), sans avorter le lot", async () => {
    h.members = [
      { id: "u1", displayName: "Jean Dupont" },
      { id: "u2", displayName: "Marie Martin" },
    ];
    h.searchRanking
      .mockResolvedValueOnce([row("DUPONT JEAN")])
      .mockResolvedValueOnce([row("MARTIN MARIE", { gender: "female" })]);
    h.upsert.mockRejectedValueOnce(new Error("Neon down")).mockResolvedValueOnce({});
    const res = await refreshRankings();
    // u1 échoue (failed), mais u2 est bien traité derrière → le lot n'est pas interrompu.
    expect(res).toMatchObject({ matched: 1, failed: 1, skipped: 0, cleared: 0 });
  });

  it("exclut les displayName vides du compteur `members` (non évaluables)", async () => {
    h.members = [
      { id: "u1", displayName: "Jean Dupont" },
      { id: "u2", displayName: "   " }, // nom vide → ignoré, ne compte pas
    ];
    h.searchRanking.mockResolvedValueOnce([]); // squashnet muet pour l'unique membre évaluable
    const res = await refreshRankings();
    // members reflète les membres RÉELLEMENT évaluables → tous ignorés (base d'un heartbeat honnête).
    expect(res).toMatchObject({ members: 1, skipped: 1, matched: 0 });
    expect(h.searchRanking).toHaveBeenCalledOnce();
  });

  it("disjoncteur : un LOT de `moved` (club renommé côté squashnet) → aucune suppression", async () => {
    // 6 membres, tous « retrouvés ailleurs » d'un coup → anomalie systémique probable.
    h.members = Array.from({ length: 6 }, (_, i) => ({ id: `u${i}`, displayName: "Jean Dupont" }));
    h.searchRanking.mockResolvedValue([row("DUPONT JEAN", { club: "Squash Club de Rennes" })]);
    const res = await refreshRankings();
    expect(res.bulkMoveBlocked).toBe(true);
    expect(res).toMatchObject({ matched: 0, cleared: 0, skipped: 6 });
    expect(h.deleteMany).not.toHaveBeenCalled();
  });

  it("départ individuel (sous le seuil) → suppression normale, pas de blocage", async () => {
    h.members = [
      { id: "u1", displayName: "Jean Dupont" }, // parti ailleurs → moved
      { id: "u2", displayName: "Marie Martin" }, // toujours au club → matched
    ];
    h.searchRanking
      .mockResolvedValueOnce([row("DUPONT JEAN", { club: "Squash Club de Rennes" })])
      .mockResolvedValueOnce([row("MARTIN MARIE", { gender: "female" })]);
    const res = await refreshRankings();
    expect(res.bulkMoveBlocked).toBe(false);
    expect(res).toMatchObject({ matched: 1, cleared: 1, skipped: 0 });
    expect(h.deleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
  });
});

// Les joueurs SANS COMPTE (`InterclubGuest`) partagent la boucle des membres depuis que leur
// classement est rapproché plutôt que saisi à la main. « Sans compte » n'est pas « sans
// licence » : ils disputent le même championnat, donc squashnet les connaît.
describe("refreshRankings — joueurs sans compte", () => {
  it("balaie les invités comme les membres, et les compte à part", async () => {
    h.guests = [{ id: "g1", name: "Paul Hors-Appli" }];
    h.searchRanking.mockResolvedValueOnce([row("HORS-APPLI PAUL")]);
    const res = await refreshRankings();
    expect(res).toMatchObject({ members: 1, guests: 1, matched: 1 });
    // Écrit sur la LIGNE de l'invité, jamais dans `SquashnetRanking` (qui exige un `User`).
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.guestUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "g1" },
        data: expect.objectContaining({ snClt: "5A", snRangM: 30, snStatus: "matched" }),
      }),
    );
  });

  it("n'écrit QUE les colonnes de rapprochement — la correction admin survit à tous les runs", async () => {
    h.guests = [{ id: "g1", name: "Paul Hors-Appli" }];
    h.searchRanking.mockResolvedValueOnce([row("HORS-APPLI PAUL")]);
    await refreshRankings();
    const data = h.guestUpdate.mock.calls[0][0].data as Record<string, unknown>;
    // Sans quoi le run mensuel écraserait le classement forcé par un admin pour un joueur que
    // squashnet retrouve mal — et personne ne comprendrait pourquoi la correction a disparu.
    expect(data).not.toHaveProperty("cltOverride");
    expect(data).not.toHaveProperty("rangMOverride");
  });

  it("note « introuvable » sur l'invité, pour que l'écran d'admin puisse le dire", async () => {
    h.guests = [{ id: "g1", name: "Paul Hors-Appli" }];
    h.searchRanking.mockResolvedValueOnce([]);
    const res = await refreshRankings();
    expect(res).toMatchObject({ matched: 0, skipped: 1 });
    // Un membre ne garde aucune trace d'un non-résultat ; un invité, si — c'est ce qui permet
    // d'écrire « pas trouvable sur squashnet » au lieu d'une ligne muette qu'on découvre
    // bloquante le soir d'une rencontre.
    expect(h.guestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "g1" },
        data: expect.objectContaining({ snStatus: "unknown" }),
      }),
    );
  });

  it("efface le rapprochement d'un invité parti dans un autre club (moved)", async () => {
    h.guests = [{ id: "g1", name: "Paul Hors-Appli" }];
    h.searchRanking.mockResolvedValueOnce([row("HORS-APPLI PAUL", { club: "Squash Club de Rennes" })]);
    const res = await refreshRankings();
    expect(res).toMatchObject({ cleared: 1 });
    const data = h.guestUpdateMany.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toMatchObject({ snClt: null, snRangM: null, snStatus: "moved" });
    // Là non plus : ce qu'un admin a saisi ne s'efface pas parce que la fédération bouge.
    expect(data).not.toHaveProperty("cltOverride");
  });

  it("le disjoncteur compte les DEUX populations ensemble", async () => {
    // Un club renommé côté squashnet rend tout le monde « moved » d'un coup, invités compris :
    // le fail-safe doit donc raisonner sur l'ensemble balayé, pas sur les seuls membres.
    h.members = Array.from({ length: 3 }, (_, i) => ({ id: `u${i}`, displayName: "Jean Dupont" }));
    h.guests = Array.from({ length: 3 }, (_, i) => ({ id: `g${i}`, name: "Jean Dupont" }));
    h.searchRanking.mockResolvedValue([row("DUPONT JEAN", { club: "Squash Club de Rennes" })]);
    const res = await refreshRankings();
    expect(res).toMatchObject({ members: 6, guests: 3, cleared: 0, bulkMoveBlocked: true });
    expect(h.deleteMany).not.toHaveBeenCalled();
    expect(h.guestUpdateMany).not.toHaveBeenCalled();
  });
});

// Un membre retiré de l'annuaire n'a pas quitté son équipe. Tant que le classement ne servait
// qu'au trombinoscope, l'ignorer était cohérent ; depuis qu'il décide de l'ORDRE DES SIMPLES,
// c'est ce qui le rendait inalignable sans qu'aucun écran ne puisse y remédier.
describe("refreshRankings — qui est balayé", () => {
  it("balaie les membres listés OU rattachés à une équipe interclub", async () => {
    await refreshRankings();
    expect(h.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { OR: [{ listed: true }, { teamId: { not: null } }] } }),
    );
  });
});

// LE NOM DE RECHERCHE CORRIGÉ PAR L'ADMIN.
//
// Le rapprochement par défaut suppose « Prénom Nom » et n'interroge la fédération que sur le
// DERNIER MOT du nom affiché. ResaMania ne garantit ni l'ordre ni l'orthographe : quand il a
// enregistré « Nom Prénom », on interroge squashnet sur un prénom, la réponse déborde, et le
// verdict est « introuvable » tous les mois sans que rien ne le signale.
describe("refreshRankings — nom de recherche corrigé", () => {
  it("interroge squashnet sur le NOM DE FAMILLE corrigé, pas sur le dernier mot affiché", async () => {
    // Nom stocké à l'envers côté ResaMania : le défaut chercherait « Matthieu ».
    h.members = [
      {
        id: "u1",
        displayName: "Soismier Matthieu",
        squashnetGivenName: "Matthieu",
        squashnetFamilyName: "Soismier",
      },
    ];
    h.searchRanking.mockResolvedValue([row("SOISMIER MATTHIEU")]);
    const res = await refreshRankings();
    expect(h.searchRanking).toHaveBeenCalledWith("Soismier", { month: "2026-07-07" });
    expect(res.matched).toBe(1);
  });

  it("ignore une correction à MOITIÉ posée et retombe sur le nom affiché", async () => {
    // Une identité amputée rendrait la recherche PLUS permissive que le défaut. L'écriture
    // l'interdit déjà ; on le revérifie ici pour qu'une ligne arrivée par un autre chemin
    // (import, correction en base) ne dégrade rien en silence.
    h.members = [
      { id: "u1", displayName: "Jean Dupont", squashnetFamilyName: "Zzz", squashnetGivenName: null },
    ];
    h.searchRanking.mockResolvedValue([row("DUPONT JEAN")]);
    await refreshRankings();
    expect(h.searchRanking).toHaveBeenCalledWith("Dupont", { month: "2026-07-07" });
  });

  it("sans correction, cherche le dernier mot du nom affiché — le comportement d'origine", async () => {
    h.members = [{ id: "u1", displayName: "Jean Dupont" }];
    h.searchRanking.mockResolvedValue([row("DUPONT JEAN")]);
    await refreshRankings();
    expect(h.searchRanking).toHaveBeenCalledWith("Dupont", { month: "2026-07-07" });
  });
});

// Le pendant pour UN membre, déclenché juste après une correction de nom. Sans lui, le mois qui
// sépare deux passages du cron serait le mois pendant lequel l'admin ne sait pas si sa
// correction a marché.
describe("refreshMemberRanking", () => {
  it("rapproche le membre sur son nom corrigé et écrit son classement", async () => {
    h.member = {
      id: "u1",
      displayName: "Soismier Matthieu",
      squashnetGivenName: "Matthieu",
      squashnetFamilyName: "Soismier",
    };
    h.searchRanking.mockResolvedValue([row("SOISMIER MATTHIEU")]);
    expect(await refreshMemberRanking("u1")).toBe("matched");
    expect(h.searchRanking).toHaveBeenCalledWith("Soismier", { month: "2026-07-07" });
    expect(h.upsert).toHaveBeenCalled();
  });

  it("« introuvable » n'efface RIEN — un silence n'est pas une preuve de départ", async () => {
    h.member = { id: "u1", displayName: "Jean Dupont" };
    h.searchRanking.mockResolvedValue([]);
    expect(await refreshMemberRanking("u1")).toBe("unknown");
    expect(h.deleteMany).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("retrouvé UNIQUEMENT hors du club → efface le classement (moved)", async () => {
    // Signal positif, celui-là : la personne existe à la fédération, sous un autre club.
    h.member = { id: "u1", displayName: "Jean Dupont" };
    h.searchRanking.mockResolvedValue([row("DUPONT JEAN", { club: "Squash Club d Ailleurs" })]);
    expect(await refreshMemberRanking("u1")).toBe("moved");
    expect(h.deleteMany).toHaveBeenCalled();
  });

  it("ne LÈVE JAMAIS sur un hoquet réseau : l'enregistrement du nom doit survivre", async () => {
    h.member = { id: "u1", displayName: "Jean Dupont" };
    h.searchRanking.mockRejectedValue(new Error("502"));
    expect(await refreshMemberRanking("u1")).toBe("unknown");
  });

  it("membre introuvable en base → « unknown », sans écriture", async () => {
    h.member = null;
    expect(await refreshMemberRanking("u1")).toBe("unknown");
    expect(h.searchRanking).not.toHaveBeenCalled();
  });
});

describe("summarizeRefresh", () => {
  const base: RefreshResult = {
    month: "2026-07-07",
    members: 5,
    guests: 0,
    matched: 3,
    cleared: 1,
    skipped: 1,
    failed: 0,
    bulkMoveBlocked: false,
  };

  it("ok quand rien d'anormal (même sans changement)", () => {
    expect(summarizeRefresh(base).ok).toBe(true);
    expect(summarizeRefresh({ ...base, matched: 0, cleared: 0, skipped: 0 }).ok).toBe(true);
  });

  it("ok=false si une écriture base a échoué", () => {
    expect(summarizeRefresh({ ...base, failed: 1 }).ok).toBe(false);
  });

  it("ok=false si le disjoncteur a bloqué des suppressions", () => {
    expect(summarizeRefresh({ ...base, bulkMoveBlocked: true }).ok).toBe(false);
  });

  it("ok=false si TOUS les membres ont été ignorés (squashnet muet)", () => {
    expect(summarizeRefresh({ ...base, matched: 0, cleared: 0, skipped: 5 }).ok).toBe(false);
  });

  it("info mentionne échecs et blocage quand présents", () => {
    const { info } = summarizeRefresh({ ...base, failed: 2, bulkMoveBlocked: true });
    expect(info).toContain("2 échec(s) base");
    expect(info).toContain("BLOQUÉE");
  });
});
