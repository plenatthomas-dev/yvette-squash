import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  follows: [] as Array<{ userId: string }>,
  lastWhere: null as null | Record<string, unknown>,
  sent: [] as Array<{ ids: readonly string[]; payload: Record<string, unknown> }>,
  throwOnQuery: false,
}));

vi.mock("./db", () => ({
  prisma: {
    interclubFollow: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        if (h.throwOnQuery) throw new Error("base injoignable");
        h.lastWhere = args.where;
        return h.follows;
      }),
    },
  },
}));
vi.mock("./push", () => ({
  pushToUsers: vi.fn(async (ids: readonly string[], payload: Record<string, unknown>) => {
    h.sent.push({ ids, payload });
    return { recipients: ids.length, sent: ids.length };
  }),
}));

import {
  frenchDate,
  notifyCalendarDrift,
  notifyAvailabilityReminder,
  notifyCaptainDigest,
  notifyFixtureDone,
  notifyFixtureStart,
  notifyGameDone,
  notifyMatchDone,
} from "./interclub-notify";

const ctx = { fixtureId: "f1", teamId: "t1", teamName: "Équipe 1", opponent: "Massy" };

beforeEach(() => {
  h.follows = [{ userId: "a" }, { userId: "b" }];
  h.lastWhere = null;
  h.sent = [];
  h.throwOnQuery = false;
});

describe("ciblage des abonnés", () => {
  it("un jeu terminé ne touche QUE le niveau détaillé", async () => {
    await notifyGameDone(ctx, "Tom", "Gégé", [{ home: 11, away: 9 }]);
    expect(h.lastWhere).toMatchObject({ teamId: "t1", level: { in: ["detailed"] } });
  });

  it("écarte les comptes DÉSACTIVÉS, comme le roster", async () => {
    // Rien ne supprime un abonnement quand on désactive un compte : un ancien membre continuait
    // de recevoir toute la soirée de scores. La règle est écrite pour `teamMemberIds` ; elle vaut
    // pour tous les carnets d'adresses du module, et le filtre se fait EN BASE.
    await notifyGameDone(ctx, "Tom", "Gégé", [{ home: 11, away: 9 }]);
    expect(h.lastWhere).toMatchObject({ user: { disabledAt: null } });
  });

  it("un match gagné touche les temps forts ET le détaillé", async () => {
    await notifyMatchDone(ctx, "Tom", "Gégé", 3, 1, { home: 1, away: 0 });
    expect(h.lastWhere).toMatchObject({ level: { in: ["highlights", "detailed"] } });
  });

  it("la fin de rencontre touche tout le monde, résultat seul compris", async () => {
    await notifyFixtureDone(ctx, { home: 3, away: 1 });
    expect(h.lastWhere).toMatchObject({ level: { in: ["result", "highlights", "detailed"] } });
  });

  it("le début de rencontre touche les temps forts", async () => {
    await notifyFixtureStart(ctx);
    expect(h.lastWhere).toMatchObject({ level: { in: ["highlights", "detailed"] } });
  });
});

describe("contenu et garde-fous", () => {
  it("porte un tag par RENCONTRE : l'écran verrouillé n'empile pas la soirée", async () => {
    await notifyFixtureStart(ctx);
    await notifyFixtureDone(ctx, { home: 3, away: 1 });
    expect(h.sent.every((s) => s.payload.tag === "interclub-f1")).toBe(true);
  });

  it("donne au RÉCAP DU CAPITAINE son propre tag : il ne remplace pas la relance", async () => {
    // Les deux partent le même jour, à J-3. Le capitaine est aussi un joueur, donc relançable :
    // avec un tag commun, il n'aurait vu que le dernier des deux — et ce sont deux messages
    // pour deux gestes différents (réponds / appelle untel).
    await notifyAvailabilityReminder(["u9"], ctx, { date: "2026-10-09" });
    await notifyCaptainDigest("u9", ctx, { date: "2026-10-09", matchCount: 4 }, { yes: 2, maybe: 1, no: 0 }, ["Xavier"]);
    const tags = h.sent.map((s) => s.payload.tag);
    expect(new Set(tags).size).toBe(2);
    expect(tags).toContain("interclub-f1-recap");
  });

  it("alerte à chaque fois malgré le tag partagé, sinon la soirée serait muette", async () => {
    await notifyFixtureDone(ctx, { home: 3, away: 1 });
    expect(h.sent[0].payload.renotify).toBe(true);
  });

  it("le résultat final porte le score de la rencontre ET le détail par joueur", async () => {
    await notifyFixtureDone(ctx, { home: 3, away: 1 }, [
      { player: "Tom", gamesHome: 3, gamesAway: 0 },
      { player: "Marc", gamesHome: 1, gamesAway: 3 },
      { player: "Luc", gamesHome: 3, gamesAway: 2 },
      { player: "Paul", gamesHome: 3, gamesAway: 1 },
    ]);
    const body = String(h.sent[0].payload.body);
    expect(body).toContain("l'emporte 3-1");
    expect(body).toContain("Tom 3-0");
    expect(body).toContain("Marc 1-3");
  });

  it("passe sous silence les matchs sans résultat", async () => {
    await notifyFixtureDone(ctx, { home: 1, away: 0 }, [
      { player: "Tom", gamesHome: 3, gamesAway: 0 },
      { player: "Marc", gamesHome: null, gamesAway: null },
    ]);
    const body = String(h.sent[0].payload.body);
    expect(body).toContain("Tom 3-0");
    expect(body).not.toContain("Marc");
  });

  it("tronque un corps trop long plutôt que de laisser le système couper au milieu d'un nom", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => ({
      player: `Joueur numéro ${i}`,
      gamesHome: 3,
      gamesAway: 0,
    }));
    await notifyFixtureDone(ctx, { home: 40, away: 0 }, lines);
    expect(String(h.sent[0].payload.body).length).toBeLessThanOrEqual(300);
  });

  // La borne était posée à l'APPEL, sur deux des quatre notifications seulement, et le titre
  // n'était borné nulle part. Elle vit désormais dans `send`, donc les quatre en héritent.
  it("borne le corps des QUATRE notifications, pas seulement des deux longues", async () => {
    const long = "N".repeat(400);
    await notifyGameDone(ctx, long, long, [{ home: 11, away: 5 }]);
    await notifyMatchDone(ctx, long, long, 3, 0, { home: 1, away: 0 });
    await notifyFixtureStart(ctx, long, long);
    await notifyFixtureDone(ctx, { home: 3, away: 0 }, [
      { player: long, gamesHome: 3, gamesAway: 0 },
    ]);
    expect(h.sent).toHaveLength(4);
    expect(h.sent.every((s) => String(s.payload.body).length <= 300)).toBe(true);
  });

  it("borne aussi le TITRE, que rien ne limitait", async () => {
    await notifyFixtureDone({ ...ctx, teamName: "É".repeat(200), opponent: "M".repeat(200) }, {
      home: 3,
      away: 0,
    });
    expect(String(h.sent[0].payload.title).length).toBeLessThanOrEqual(120);
  });

  it("nomme le match qui démarre", async () => {
    await notifyFixtureStart(ctx, "Tom", "Gégé");
    expect(String(h.sent[0].payload.body)).toContain("Tom c. Gégé");
  });

  it("reste lisible si le match qui démarre n'est pas connu", async () => {
    await notifyFixtureStart(ctx);
    expect(String(h.sent[0].payload.body)).toBe("La rencontre commence.");
  });

  it("dit qui gagne et où en est la rencontre", async () => {
    await notifyMatchDone(ctx, "Tom", "Gégé", 3, 1, { home: 2, away: 1 });
    expect(String(h.sent[0].payload.body)).toContain("Tom gagne 3-1");
    expect(String(h.sent[0].payload.body)).toContain("2-1");
  });

  it("annonce une défaite sans détour", async () => {
    await notifyMatchDone(ctx, "Tom", "Gégé", 1, 3, { home: 0, away: 1 });
    expect(String(h.sent[0].payload.body)).toContain("Tom perd 1-3");
  });

  it("reconnaît le match nul de la rencontre", async () => {
    await notifyFixtureDone(ctx, { home: 2, away: 2 });
    expect(String(h.sent[0].payload.body)).toContain("match nul");
  });

  it("n'envoie rien quand personne n'est abonné", async () => {
    h.follows = [];
    await notifyFixtureDone(ctx, { home: 3, away: 1 });
    expect(h.sent).toEqual([]);
  });

  it("une panne de base ne remonte pas : notifier reste best-effort", async () => {
    h.throwOnQuery = true;
    await expect(notifyFixtureDone(ctx, { home: 3, away: 1 })).resolves.toBeUndefined();
    expect(h.sent).toEqual([]);
  });
});

describe("frenchDate", () => {
  it("écrit la date en toutes lettres, sans l'année", () => {
    // Une rencontre annoncée se joue dans les semaines qui viennent : « 2026 » n'apprend rien
    // dans une notification qu'on lit d'un coup d'œil.
    expect(frenchDate("2026-10-09")).toBe("vendredi 9 octobre");
  });

  it("ne dépend pas du fuseau de la machine", () => {
    // Un décalage d'un jour se lit comme un rendez-vous manqué. La date est composée en UTC de
    // bout en bout, et le 1er du mois est le cas où l'erreur se voit.
    expect(frenchDate("2026-01-01")).toBe("jeudi 1 janvier");
  });

  it("REND LA CHAÎNE TELLE QUELLE sur une date hors bornes, au lieu d'en inventer une", () => {
    // `Date.UTC` déborde volontiers : « 2026-13-45 » devenait « samedi 14 février », crédible
    // et faux de six semaines — dans un message qui convoque une équipe. Une date illisible se
    // remarque, une date fausse non.
    expect(frenchDate("2026-13-45")).toBe("2026-13-45");
    expect(frenchDate("2026-02-31")).toBe("2026-02-31");
    expect(frenchDate("pas une date")).toBe("pas une date");
  });
});

describe("notifyCalendarDrift", () => {
  const equipe = { id: "t1", name: "Équipe 1" };

  it("annonce les écarts et renvoie vers l'espace admin, sans rien appliquer", async () => {
    await notifyCalendarDrift(["a"], equipe, ["J1 déplacée au 2026-10-16"]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].payload).toMatchObject({ url: "/admin" });
    expect(h.sent[0].payload.title).toContain("Équipe 1");
    expect(h.sent[0].payload.body).toContain("J1 déplacée au 2026-10-16");
  });

  it("étiquette sur l'IDENTIFIANT de l'équipe, jamais sur son nom", async () => {
    // Le tag fait qu'une alerte remplace la précédente. Bâti sur le nom, un renommage faisait
    // cohabiter deux alertes pour la même équipe, et deux équipes homonymes n'auraient jamais
    // pu se remplacer l'une l'autre.
    await notifyCalendarDrift(["a"], equipe, ["J1 modifiée"]);
    expect(h.sent[0].payload.tag).toBe("interclub-calendrier-t1");
  });

  it("ne garde que les trois premiers écarts, et COMPTE le reste", async () => {
    // Une notification tronquée sans le compte laisserait croire qu'il n'y a que trois lignes.
    await notifyCalendarDrift(["a"], equipe, ["J1", "J2", "J3", "J4", "J5"]);
    expect(h.sent[0].payload.body).toContain("J1 · J2 · J3 (+2)");
  });

  it("n'envoie RIEN quand personne ne peut agir", async () => {
    // Sans capitaine ni admin joignable, il n'y a pas de destinataire : pousser dans le vide
    // consommerait le quota et masquerait un vrai problème de configuration.
    await notifyCalendarDrift([], equipe, ["J1 modifiée"]);
    expect(h.sent).toEqual([]);
  });
});
