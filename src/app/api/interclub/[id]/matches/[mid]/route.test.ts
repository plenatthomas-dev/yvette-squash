import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  interclub: true,
  session: null as null | { userId: string },
  match: null as null | Record<string, unknown>,
  siblings: [] as Array<Record<string, unknown>>,
  user: null as null | Record<string, unknown>,
  guest: null as null | Record<string, unknown>,
  admin: false,
  // Ce que la transaction a réellement écrit.
  updated: null as null | Record<string, unknown>,
  createdGames: null as null | Array<Record<string, unknown>>,
  deletedGames: 0,
  fixtureStatus: null as null | string,
  fixtureUpdate: null as null | Record<string, unknown>,
  notified: [] as string[],
  lastPlayers: null as null | { player: string; opponent: string },
  /** Simple de la même rencontre qui aligne déjà le joueur choisi (null = aucun conflit). */
  alignmentClash: null as null | { order: number },
}));

vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({ interclub: h.interclub }),
}));
vi.mock("@/lib/interclub-gate", () => ({ interclubChanged: vi.fn() }));
vi.mock("@/lib/interclub-notify", () => ({
  notifyGameDone: vi.fn(async (_ctx: unknown, player: string, opponent: string) => {
    h.notified.push("gameDone");
    h.lastPlayers = { player, opponent };
  }),
  notifyMatchDone: vi.fn(async () => {
    h.notified.push("matchDone");
  }),
  notifyFixtureDone: vi.fn(async () => {
    h.notified.push("fixtureDone");
  }),
  notifyFixtureStart: vi.fn(async () => {
    h.notified.push("fixtureStart");
  }),
}));
vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/admin", () => ({ isAdminEmail: vi.fn(() => h.admin) }));
vi.mock("@/lib/db", () => {
  const tx = {
    interclubMatch: {
      findUnique: vi.fn(async () => h.match),
      findMany: vi.fn(async () => h.siblings),
      findFirst: vi.fn(async () => h.alignmentClash),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        h.updated = args.data;
        return {};
      }),
    },
    interclubGame: {
      deleteMany: vi.fn(async () => {
        h.deletedGames += 1;
        return { count: 0 };
      }),
      createMany: vi.fn(async (args: { data: Array<Record<string, unknown>> }) => {
        h.createdGames = args.data;
        return { count: args.data.length };
      }),
    },
    interclub: {
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        h.fixtureStatus = args.data.status as string;
        h.fixtureUpdate = args.data;
        return {};
      }),
    },
    user: { findUnique: vi.fn(async () => h.user) },
    interclubGuest: { findUnique: vi.fn(async () => h.guest) },
  };
  return {
    prisma: {
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
      user: { findUnique: vi.fn(async () => h.user) },
    },
  };
});

import { PATCH } from "./route";

const ctx = { params: Promise.resolve({ id: "f1", mid: "m1" }) };
const patch = (body: unknown) =>
  ({ cookies: { get: () => undefined }, json: async () => body }) as unknown as NextRequest;

/** Un match vierge d'une rencontre au meilleur des 5. */
const NOTIFIED = new Date(Date.now() - 20 * 60_000);

const freshMatch = () => ({
  id: "m1",
  interclubId: "f1",
  homeUserId: "u9",
  scorerId: null,
  gamesHome: null,
  gamesAway: null,
  homeDisplayName: "Tom",
  awayName: "Gégé",
  games: [] as Array<{ number: number }>,
  interclub: {
    id: "f1",
    bestOf: 5,
    matchCount: 4,
    createdById: "u1",
    teamId: "team-1",
    status: "live",
    // Une rencontre déjà en cours a vu partir son « la rencontre commence ».
    startNotifiedAt: NOTIFIED,
    doneNotifiedAt: null as Date | null,
    opponent: "Massy",
    team: { name: "Équipe 1" },
  },
});

beforeEach(() => {
  h.interclub = true;
  h.session = { userId: "u1" };
  h.match = freshMatch();
  h.siblings = [{ gamesHome: null, status: "pending" }];
  h.user = { email: "someone@example.com", teamId: "team-1" };
  h.guest = null;
  h.admin = false;
  h.updated = null;
  h.createdGames = null;
  h.deletedGames = 0;
  h.fixtureStatus = null;
  h.fixtureUpdate = null;
  h.notified = [];
  h.lastPlayers = null;
  h.alignmentClash = null;
});

describe("PATCH /api/interclub/{id}/matches/{mid}", () => {
  it("404 si la fonction est désactivée", async () => {
    h.interclub = false;
    expect((await PATCH(patch({}), ctx)).status).toBe(404);
  });

  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await PATCH(patch({}), ctx)).status).toBe(401);
  });

  it("404 si le match est introuvable", async () => {
    h.match = null;
    expect((await PATCH(patch({}), ctx)).status).toBe(404);
  });

  it("404 si le match appartient à une autre rencontre", async () => {
    h.match = { ...freshMatch(), interclubId: "AUTRE" };
    expect((await PATCH(patch({}), ctx)).status).toBe(404);
  });

  it("enregistre un 3-0 et clôt le match", async () => {
    const res = await PATCH(
      patch({
        games: [
          { home: 11, away: 5 },
          { home: 11, away: 8 },
          { home: 11, away: 9 },
        ],
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(h.updated).toMatchObject({ gamesHome: 3, gamesAway: 0, status: "done" });
    expect(h.createdGames).toHaveLength(3);
    expect(h.createdGames?.[0]).toMatchObject({ number: 1, pointsHome: 11, pointsAway: 5 });
  });

  it("libère la prise de marquage quand le match est fini", async () => {
    await PATCH(
      patch({ games: [{ home: 11, away: 1 }, { home: 11, away: 2 }, { home: 11, away: 3 }] }),
      ctx,
    );
    expect(h.updated).toMatchObject({ scorerClaimedAt: null, liveJson: null });
  });

  it("remplace intégralement les jeux au lieu de les empiler", async () => {
    await PATCH(patch({ games: [{ home: 11, away: 5 }] }), ctx);
    expect(h.deletedGames).toBe(1);
    expect(h.createdGames).toHaveLength(1);
  });

  it("un match mené 1-0 reste en cours, pas terminé", async () => {
    await PATCH(patch({ games: [{ home: 11, away: 5 }] }), ctx);
    expect(h.updated).toMatchObject({ status: "live" });
  });

  it("une liste de jeux vide remet le match à zéro", async () => {
    await PATCH(patch({ games: [] }), ctx);
    expect(h.updated).toMatchObject({ gamesHome: null, gamesAway: null, status: "pending" });
    expect(h.createdGames).toBeNull();
  });

  it("refuse un score impossible pour le format (4e jeu après un 3-0)", async () => {
    const res = await PATCH(
      patch({
        games: [
          { home: 11, away: 5 },
          { home: 11, away: 8 },
          { home: 11, away: 9 },
          { home: 11, away: 4 },
        ],
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("refuse un jeu non terminé", async () => {
    const res = await PATCH(patch({ games: [{ home: 7, away: 4 }] }), ctx);
    expect(res.status).toBe(400);
  });

  it("refuse ce qui n'est pas une couleur", async () => {
    expect((await PATCH(patch({ homeColor: "bleu-ciel" }), ctx)).status).toBe(400);
    expect((await PATCH(patch({ homeColor: "#12345" }), ctx)).status).toBe(400);
  });

  it("recale le statut de la rencontre dans la même transaction", async () => {
    h.siblings = [
      { gamesHome: 3, status: "done" },
      { gamesHome: 3, status: "done" },
      { gamesHome: 3, status: "done" },
      { gamesHome: 3, status: "done" },
    ];
    await PATCH(patch({ games: [{ home: 11, away: 5 }] }), ctx);
    expect(h.fixtureStatus).toBe("done");
  });

  it("409 si le score est déjà saisi et qu'on n'a rien à voir avec ce match", async () => {
    h.match = { ...freshMatch(), gamesHome: 3, gamesAway: 1, homeUserId: "autre" };
    h.session = { userId: "intrus" };
    const res = await PATCH(patch({ games: [{ home: 11, away: 0 }] }), ctx);
    expect(res.status).toBe(409);
  });

  it("le créateur de la rencontre peut corriger un score déjà saisi", async () => {
    h.match = { ...freshMatch(), gamesHome: 3, gamesAway: 1, homeUserId: "autre" };
    h.session = { userId: "u1" }; // createdById
    expect((await PATCH(patch({ games: [{ home: 11, away: 0 }] }), ctx)).status).toBe(200);
  });

  it("le joueur concerné peut corriger son propre score", async () => {
    h.match = { ...freshMatch(), gamesHome: 3, gamesAway: 1, homeUserId: "u7" };
    h.session = { userId: "u7" };
    expect((await PATCH(patch({ games: [{ home: 11, away: 0 }] }), ctx)).status).toBe(200);
  });

  it("un admin peut corriger un score déjà saisi", async () => {
    h.match = { ...freshMatch(), gamesHome: 3, gamesAway: 1, homeUserId: "autre" };
    h.session = { userId: "intrus" };
    h.admin = true;
    expect((await PATCH(patch({ games: [{ home: 11, away: 0 }] }), ctx)).status).toBe(200);
  });

  it("rattacher un membre fige son nom d'affichage", async () => {
    h.user = { id: "u9", displayName: "Jérôme Blanc", nickname: "Jéjé", teamId: "team-1" };
    await PATCH(patch({ homeUserId: "u9" }), ctx);
    expect(h.updated).toMatchObject({ homeDisplayName: "Jéjé" });
  });

  it("refuse de rattacher un membre inconnu", async () => {
    h.user = null;
    expect((await PATCH(patch({ homeUserId: "fantome" }), ctx)).status).toBe(400);
  });

  it("refuse un membre d'une AUTRE équipe : la règle tient côté serveur, pas seulement à l'écran", async () => {
    h.user = { id: "u9", displayName: "Jérôme", nickname: null, teamId: "team-2" };
    const res = await PATCH(patch({ homeUserId: "u9" }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/équipe qui dispute/);
  });

  it("refuse un membre sans équipe", async () => {
    h.user = { id: "u9", displayName: "Jérôme", nickname: null, teamId: null };
    expect((await PATCH(patch({ homeUserId: "u9" }), ctx)).status).toBe(400);
  });

  it("refuse d'aligner un joueur qui dispute déjà un autre simple de la rencontre", async () => {
    h.user = { id: "u9", displayName: "Jérôme Blanc", nickname: "Jéjé", teamId: "team-1" };
    h.alignmentClash = { order: 2 };
    const res = await PATCH(patch({ homeUserId: "u9" }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/dispute déjà le match n° 2/);
    expect(h.updated).toBeNull();
  });

  it("« à désigner » n'est jamais un doublon, même sur plusieurs simples", async () => {
    // Le conflit ne porte que sur une PERSONNE : sans quoi la deuxième ligne encore à
    // composer serait refusée au motif que la première l'est aussi.
    h.alignmentClash = { order: 2 };
    const res = await PATCH(patch({ homeUserId: null }), ctx);
    expect(res.status).toBe(200);
    expect(h.updated).toMatchObject({ homeDisplayName: "À désigner" });
  });

  it("détache le joueur et remet le placeholder", async () => {
    await PATCH(patch({ homeUserId: null, homeDisplayName: "À désigner" }), ctx);
    expect(h.updated).toMatchObject({ homeDisplayName: "À désigner" });
    expect(h.updated?.homeUser).toEqual({ disconnect: true });
  });

  it("le nom d'un membre rattaché prime sur un nom envoyé en même temps", async () => {
    h.user = { id: "u9", displayName: "Jérôme Blanc", nickname: "Jéjé", teamId: "team-1" };
    await PATCH(patch({ homeUserId: "u9", homeDisplayName: "Truc" }), ctx);
    expect(h.updated).toMatchObject({ homeDisplayName: "Jéjé" });
  });

  it("une saisie a posteriori annonce un jeu terminé, comme le direct", async () => {
    // Un club qui n'utilise jamais l'écran de marquage ne recevait RIEN avant le tout
    // dernier match, même abonné au niveau « détaillé ».
    await PATCH(patch({ games: [{ home: 11, away: 5 }] }), ctx);
    expect(h.notified).toEqual(["gameDone"]);
  });

  it("annonce le match gagné plutôt que le jeu, quand les deux surviennent", async () => {
    await PATCH(
      patch({ games: [{ home: 11, away: 5 }, { home: 11, away: 8 }, { home: 11, away: 9 }] }),
      ctx,
    );
    expect(h.notified).toContain("matchDone");
    expect(h.notified).not.toContain("gameDone");
  });

  it("annonce les noms QU'ON VIENT DE CHOISIR, pas « à désigner »", async () => {
    // Composer l'équipe et saisir le score d'un même geste est le cas ordinaire. La
    // notification lisait les noms d'AVANT la mise à jour et annonçait donc
    // « à désigner c. à désigner » alors que les joueurs venaient d'être renseignés.
    h.match = { ...freshMatch(), homeDisplayName: "À désigner", awayName: "À désigner" };
    h.user = { id: "u9", displayName: "Laurent Petit", nickname: null, teamId: "team-1" };
    await PATCH(
      patch({ homeUserId: "u9", awayName: "Gégé", games: [{ home: 11, away: 5 }] }),
      ctx,
    );
    expect(h.notified).toEqual(["gameDone"]);
    expect(h.lastPlayers).toEqual({ player: "Laurent Petit", opponent: "Gégé" });
  });

  it("garde les noms déjà en base quand la requête n'en fournit pas", async () => {
    await PATCH(patch({ games: [{ home: 11, away: 5 }] }), ctx);
    expect(h.lastPlayers).toEqual({ player: "Tom", opponent: "Gégé" });
  });

  it("une CORRECTION qui n'avance rien ne notifie personne", async () => {
    // C'est tout l'intérêt des gardes de transition : corriger un 11-5 en 11-7 est une
    // rectification, pas un événement.
    h.match = { ...freshMatch(), games: [{ number: 1 }], gamesHome: 1, gamesAway: 0 };
    await PATCH(patch({ games: [{ home: 11, away: 7 }] }), ctx);
    expect(h.notified).toEqual([]);
  });

  it("ne réannonce pas un match déjà terminé", async () => {
    h.match = {
      ...freshMatch(),
      status: "done",
      gamesHome: 3,
      gamesAway: 0,
      games: [{ number: 1 }, { number: 2 }, { number: 3 }],
    };
    await PATCH(
      patch({ games: [{ home: 11, away: 5 }, { home: 11, away: 8 }, { home: 11, away: 9 }] }),
      ctx,
    );
    expect(h.notified).not.toContain("matchDone");
  });

  it("accepte une couleur libre et la normalise", async () => {
    await PATCH(patch({ homeColor: "#A1B2C3" }), ctx);
    expect(h.updated).toMatchObject({ homeColor: "#a1b2c3" });
  });

  it("refuse un score impossible que « 11 points et 2 d'écart » laisserait passer", async () => {
    // 12-0 satisfait la règle naïve mais n'a pas pu exister : au-delà de 11 on ne marque
    // que pour prendre 2 points d'écart.
    expect((await PATCH(patch({ games: [{ home: 12, away: 0 }] }), ctx)).status).toBe(400);
  });

  // --- La prise de marquage ------------------------------------------------
  // Cette route ignorait totalement `scorerId`, alors que sa sœur `PUT …/live` s'en protège.
  // Deux conséquences, toutes deux atteignables sans malveillance un soir de rencontre.

  it("refuse d'écrire des jeux pendant qu'un AUTRE marque ce match", async () => {
    h.match = {
      ...freshMatch(),
      scorerId: "marqueur",
      scorerClaimedAt: new Date(), // prise fraîche, donc non périmée
      status: "live",
    };
    const res = await PATCH(patch({ games: [{ home: 11, away: 0 }] }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/marque ce match/i);
    expect(h.deletedGames).toBe(0);
  });

  // Le scénario coûteux : un match VERROUILLÉ par un tiers. Un PATCH d'un score complet
  // posait `status: done` et relâchait la prise, après quoi le marqueur légitime prenait 409
  // sur son propre PUT et ne pouvait plus faire remonter ses points.
  it("ne peut plus terminer d'autorité un match tenu par un marqueur", async () => {
    h.match = {
      ...freshMatch(),
      scorerId: "marqueur",
      scorerClaimedAt: new Date(),
      status: "live",
    };
    const res = await PATCH(
      patch({ games: [{ home: 11, away: 0 }, { home: 11, away: 0 }, { home: 11, away: 0 }] }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(h.updated).toBeNull();
  });

  it("une prise PÉRIMÉE ne bloque plus la correction du score", async () => {
    h.match = {
      ...freshMatch(),
      scorerId: "marqueur",
      scorerClaimedAt: new Date(Date.now() - 60 * 60_000), // une heure : périmée
      status: "live",
    };
    expect((await PATCH(patch({ games: [{ home: 11, away: 0 }] }), ctx)).status).toBe(200);
  });

  it("le marqueur lui-même peut corriger le score de son match", async () => {
    h.match = {
      ...freshMatch(),
      scorerId: "u1",
      scorerClaimedAt: new Date(),
      status: "live",
    };
    expect((await PATCH(patch({ games: [{ home: 11, away: 0 }] }), ctx)).status).toBe(200);
  });

  // La composition n'est pas le score : corriger un nom au bord du terrain reste possible
  // pendant que quelqu'un marque, parce que ça ne touche aucun jeu.
  it("laisse corriger la composition pendant qu'un autre marque", async () => {
    h.match = {
      ...freshMatch(),
      scorerId: "marqueur",
      scorerClaimedAt: new Date(),
      status: "live",
    };
    expect((await PATCH(patch({ awayName: "Vrai nom" }), ctx)).status).toBe(200);
  });

  // --- Concurrence optimiste sur les jeux ----------------------------------

  // LE scénario de perte de données : `games` remplace intégralement, et un écran ouvert dix
  // minutes plus tôt renvoie la liste qu'il avait alors. Les deux écritures ne sont pas
  // concurrentes — le Serializable ne voit donc rien —, la seconde est simplement calculée sur
  // un état périmé, et elle efface le jeu clos entre-temps.
  it("refuse une saisie calculée sur un nombre de jeux périmé", async () => {
    h.match = { ...freshMatch(), games: [{ number: 1 }], gamesHome: 1, gamesAway: 0 };
    const res = await PATCH(patch({ games: [], knownGameCount: 0 }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/changé pendant ta saisie/i);
    expect(h.deletedGames).toBe(0);
  });

  it("accepte la même saisie quand l'écran est à jour", async () => {
    h.match = { ...freshMatch(), games: [{ number: 1 }], gamesHome: 1, gamesAway: 0 };
    expect((await PATCH(patch({ games: [], knownGameCount: 1 }), ctx)).status).toBe(200);
  });

  // Garde FACULTATIVE : un client qui ne l'envoie pas garde l'ancien comportement.
  it("n'exige pas knownGameCount", async () => {
    h.match = { ...freshMatch(), games: [{ number: 1 }], gamesHome: 1, gamesAway: 0 };
    expect((await PATCH(patch({ games: [] }), ctx)).status).toBe(200);
  });

  // --- « Entamé » ne se lit pas sur gamesHome seul -------------------------

  // `gamesHome` reste NULL pendant tout le premier jeu : la garde d'autorisation ne servait
  // donc à rien exactement au moment où le match est le plus vivant.
  it("protège un match en cours dès le premier jeu, avant tout jeu terminé", async () => {
    h.match = {
      ...freshMatch(),
      status: "live",
      gamesHome: null,
      homeUserId: "autre",
      interclub: { ...freshMatch().interclub, createdById: "autre" },
    };
    h.session = { userId: "intrus" };
    const res = await PATCH(patch({ games: [{ home: 11, away: 0 }] }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/déjà saisi/i);
  });

  // --- Joueurs sans compte -------------------------------------------------

  it("aligne un joueur hors appli du roster de l'équipe", async () => {
    h.guest = { id: "g1", name: "Paul Hors-Appli", teamId: "team-1" };
    await PATCH(patch({ homeGuestId: "g1" }), ctx);
    expect(h.updated).toMatchObject({ homeDisplayName: "Paul Hors-Appli" });
    expect(h.updated?.homeGuest).toEqual({ connect: { id: "g1" } });
    expect(h.updated?.homeUser).toEqual({ disconnect: true });
  });

  it("refuse un joueur hors appli d'une autre équipe", async () => {
    h.guest = { id: "g1", name: "Paul", teamId: "team-2" };
    expect((await PATCH(patch({ homeGuestId: "g1" }), ctx)).status).toBe(400);
  });

  it("refuse de désigner à la fois un membre et un joueur hors appli", async () => {
    h.user = { id: "u9", displayName: "Jérôme", nickname: null, teamId: "team-1" };
    h.guest = { id: "g1", name: "Paul", teamId: "team-1" };
    expect((await PATCH(patch({ homeUserId: "u9", homeGuestId: "g1" }), ctx)).status).toBe(400);
  });

  // Le placeholder est posé PAR LE SERVEUR : c'était la dernière porte par laquelle un nom
  // libre entrait, et donc par laquelle la règle d'équipe se contournait.
  it("ignore un nom libre envoyé avec un détachement", async () => {
    await PATCH(patch({ homeUserId: null, homeGuestId: null, homeDisplayName: "N'importe qui" }), ctx);
    expect(h.updated).toMatchObject({ homeDisplayName: "À désigner" });
  });

  // --- Début de rencontre --------------------------------------------------

  // Le commentaire de la route promet « les MÊMES transitions que le direct », mais
  // `notifyFixtureStart` n'existait que côté direct : un club qui saisit tout a posteriori —
  // le cas que ce raisonnement dit vouloir couvrir — ne l'a jamais reçu.
  it("annonce le début de rencontre, comme le direct, et pose le marqueur", async () => {
    h.match = {
      ...freshMatch(),
      interclub: { ...freshMatch().interclub, status: "scheduled", startNotifiedAt: null },
    };
    h.siblings = [{ gamesHome: 1, status: "live" }];
    await PATCH(patch({ games: [{ home: 11, away: 0 }] }), ctx);
    expect(h.notified).toContain("fixtureStart");
    expect(h.fixtureUpdate?.startNotifiedAt).toBeInstanceOf(Date);
  });

  it("ne réannonce pas le début d'une rencontre déjà en cours", async () => {
    h.match = { ...freshMatch(), interclub: { ...freshMatch().interclub, status: "live" } };
    h.siblings = [{ gamesHome: 1, status: "live" }];
    await PATCH(patch({ games: [{ home: 11, away: 0 }] }), ctx);
    expect(h.notified).not.toContain("fixtureStart");
  });

  // --- Correction en DEUX temps --------------------------------------------
  //
  // Le formulaire de saisie n'offre qu'un « ✕ » par ligne : corriger un score revient
  // naturellement à vider les jeux, enregistrer, puis ressaisir. La rencontre redescend alors
  // de `done` à `live`, ce qu'une garde comparant le statut STOCKÉ prenait pour un début de
  // rencontre — puis pour une fin toute neuve au second enregistrement.

  it("ne réannonce pas le début quand une rencontre terminée redescend en direct", async () => {
    h.match = {
      ...freshMatch(),
      games: [{ number: 1 }],
      interclub: {
        ...freshMatch().interclub,
        status: "done",
        startNotifiedAt: NOTIFIED,
        doneNotifiedAt: NOTIFIED,
      },
    };
    // Trois simples restent clos, le quatrième vient d'être vidé : la rencontre redescend
    // RÉELLEMENT de `done` à `live`, c'est-à-dire la transition qui trompait l'ancienne garde.
    h.siblings = [
      { gamesHome: null, status: "pending" },
      { gamesHome: 3, status: "done" },
      { gamesHome: 3, status: "done" },
      { gamesHome: 3, status: "done" },
    ];
    await PATCH(patch({ games: [], knownGameCount: 1 }), ctx);
    expect(h.fixtureStatus).toBe("live");
    expect(h.notified).not.toContain("fixtureStart");
    expect(h.fixtureUpdate?.startNotifiedAt).toBeUndefined();
  });

  it("ne réannonce pas le résultat quand le bon score est ressaisi derrière", async () => {
    h.match = {
      ...freshMatch(),
      interclub: {
        ...freshMatch().interclub,
        status: "live",
        startNotifiedAt: NOTIFIED,
        doneNotifiedAt: NOTIFIED,
      },
    };
    // Les quatre simples sont clos : la rencontre repasse bien à `done`, donc la transition
    // existe. C'est le marqueur, et lui seul, qui retient l'annonce.
    h.siblings = Array.from({ length: 4 }, () => ({ gamesHome: 3, status: "done" }));
    await PATCH(patch({ games: [{ home: 11, away: 0 }] }), ctx);
    expect(h.fixtureStatus).toBe("done");
    expect(h.notified).not.toContain("fixtureDone");
    expect(h.fixtureUpdate?.doneNotifiedAt).toBeUndefined();
  });
});
