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
