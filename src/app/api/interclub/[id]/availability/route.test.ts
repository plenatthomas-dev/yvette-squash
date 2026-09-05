import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// LES DISPONIBILITÉS D'UNE RENCONTRE.
//
// Deux choses valent qu'on les verrouille ici, parce qu'aucune ne se voit à la relecture :
//
//  1. L'écran part du ROSTER, pas des réponses. Ceux qui n'ont rien dit doivent apparaître —
//     ce sont eux qui intéressent le capitaine —, et parmi eux, ceux qu'AUCUNE relance
//     n'atteindra (joueurs sans compte, membres sans notifications) doivent être séparés :
//     relancer par notification quelqu'un qui n'en reçoit pas ne coûte rien mais ne produit
//     rien, et laisse croire que le travail est fait.
//
//  2. On peut répondre POUR quelqu'un d'autre — sinon l'outil ne sert à rien pour la moitié du
//     roster. La garantie n'est pas une restriction mais une trace (`setById`) et une
//     confirmation explicite avant d'écraser ce que quelqu'un a dit lui-même.

const h = vi.hoisted(() => ({
  interclub: true,
  session: null as null | { userId: string; email: string },
  fixture: null as null | Record<string, unknown>,
  /** Membres de l'équipe, tels que `user.findMany` les rend (avec `pushSubs`). */
  members: [] as Array<Record<string, unknown>>,
  guests: [] as Array<Record<string, unknown>>,
  answers: [] as Array<Record<string, unknown>>,
  /** L'utilisateur que `user.findUnique` rend (le demandeur, puis le sujet visé). */
  users: {} as Record<string, { teamId: string | null } | null>,
  guestById: {} as Record<string, { teamId: string } | null>,
  /** Les appels à `interclubAvailability` passés HORS transaction, dans l'ordre. */
  horsTx: [] as string[],
  created: null as null | Record<string, unknown>,
  updated: null as null | { where: unknown; data: Record<string, unknown> },
}));

vi.mock("@/lib/features-server", () => ({ getFeatures: async () => ({ interclub: h.interclub }) }));
vi.mock("@/lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session")>()),
  getSession: vi.fn(async () => h.session),
}));
/**
 * Un `where` de Prisma, HONORÉ champ par champ.
 *
 * Le faux l'ignorait et rendait la première réponse marquée d'un drapeau de test. Trois cas —
 * le 409 sur réponse de première main, la correction sans confirmation, le relais remplacé —
 * passaient donc à l'identique si la route était allée chercher la réponse de QUELQU'UN
 * D'AUTRE, ou celle d'une AUTRE rencontre. La discrimination membre/invité n'était couverte par
 * rien. Un faux qui ignore son `where` ne mesure pas la requête, il la suppose.
 */
const correspond = (row: Record<string, unknown>, where: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) => (row[k] ?? null) === (v ?? null));

vi.mock("@/lib/db", () => {
  const dispos = {
    findMany: vi.fn(async (args: { where: Record<string, unknown> }) =>
      h.answers.filter((a) => correspond(a, args.where)),
    ),
    findFirst: vi.fn(async (args: { where: Record<string, unknown> }) =>
      h.answers.find((a) => correspond(a, args.where)) ?? null,
    ),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      h.created = args.data;
      return args.data;
    }),
    update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
      h.updated = args;
      return args.data;
    }),
  };

  const commun = () => ({
    interclub: { findUnique: vi.fn(async () => h.fixture) },
    user: {
      findMany: vi.fn(async () => h.members),
      findUnique: vi.fn(async (args: { where: { id: string } }) => h.users[args.where.id] ?? null),
    },
    interclubGuest: {
      findMany: vi.fn(async () => h.guests),
      findUnique: vi.fn(async (args: { where: { id: string } }) => h.guestById[args.where.id] ?? null),
    },
  });

  // DEUX CLIENTS DISTINCTS, et c'est ce qui rend la question mesurable. Tant que `$transaction`
  // repassait le MÊME faux au corps, « lire dans la transaction » et « lire dehors » étaient
  // indiscernables — or c'est exactement là que se jouait le défaut. Le client hors transaction
  // note donc chaque appel qui passe par lui, et les tests peuvent l'exiger vide.
  const tx = { ...commun(), interclubAvailability: dispos };
  const dehors = Object.fromEntries(
    Object.entries(dispos).map(([nom, fn]) => [
      nom,
      async (args: never) => {
        h.horsTx.push(nom);
        return fn(args);
      },
    ]),
  );
  const prisma: Record<string, unknown> = { ...commun(), interclubAvailability: dehors };
  prisma.$transaction = async (run: (t: unknown) => Promise<unknown>) => run(tx);
  return { prisma };
});

import { GET, PUT } from "./route";

const ctx = { params: Promise.resolve({ id: "f1" }) };
const req = (body?: unknown) =>
  ({ cookies: { get: () => undefined }, json: async () => body ?? {} }) as unknown as NextRequest;

/** Un membre de l'équipe, joignable par défaut. */
const membre = (id: string, name: string, joignable = true) => ({
  id,
  displayName: name,
  nickname: null,
  pushSubs: joignable ? [{ id: "s1" }] : [],
});

beforeEach(() => {
  h.interclub = true;
  h.session = { userId: "u1", email: "alice@ex.com" };
  h.fixture = { id: "f1", teamId: "t1", matchCount: 4, date: "2026-10-09" };
  h.members = [membre("u1", "Alice"), membre("u2", "Bob")];
  h.guests = [];
  h.answers = [];
  h.users = { u1: { teamId: "t1" }, u2: { teamId: "t1" } };
  h.guestById = {};
  h.horsTx = [];
  h.created = null;
  h.updated = null;
});

describe("GET /api/interclub/{id}/availability", () => {
  it("404 quand l'interclub est coupé, avant même de regarder la rencontre", async () => {
    h.interclub = false;
    expect((await GET(req(), ctx)).status).toBe(404);
  });

  it("401 sans session — et 404 d'abord si la fonction est coupée", async () => {
    // L'ordre compte autant que les codes : on ne révèle pas l'existence d'une fonction
    // désactivée à quelqu'un qui n'est même pas connecté.
    h.session = null;
    expect((await GET(req(), ctx)).status).toBe(401);
    h.interclub = false;
    expect((await GET(req(), ctx)).status).toBe(404);
  });

  it("401 en ÉCRITURE aussi, et rien n'est enregistré", async () => {
    h.session = null;
    expect((await PUT(req({ status: "yes" }), ctx)).status).toBe(401);
    expect(h.created).toBeNull();
    expect(h.updated).toBeNull();
  });

  it("404 sur une rencontre inconnue, en lecture comme en écriture", async () => {
    h.fixture = null;
    expect((await GET(req(), ctx)).status).toBe(404);
    expect((await PUT(req({ status: "yes" }), ctx)).status).toBe(404);
    expect(h.created).toBeNull();
  });

  it("403 pour un membre d'une AUTRE équipe", async () => {
    // On parle de la disponibilité de gens qui jouent ensemble : quelqu'un qui ne dispute pas
    // cette rencontre n'a rien à y lire.
    h.users.u1 = { teamId: "t2" };
    expect((await GET(req(), ctx)).status).toBe(403);
  });

  it("403 pour un membre rattaché à aucune équipe", async () => {
    h.users.u1 = { teamId: null };
    expect((await GET(req(), ctx)).status).toBe(403);
  });

  it("liste TOUT le roster, y compris ceux qui n'ont rien répondu", async () => {
    // Partir des réponses enregistrées donnerait l'illusion d'une équipe complète : les
    // silencieux disparaîtraient, alors que ce sont eux qui intéressent le capitaine.
    const { entries } = await (await GET(req(), ctx)).json();
    expect(entries.map((e: { name: string; status: null }) => [e.name, e.status])).toEqual([
      ["Alice", null],
      ["Bob", null],
    ]);
  });

  it("mêle les joueurs SANS COMPTE au roster, triés avec les autres", async () => {
    h.guests = [{ id: "g1", name: "Aaron Hors-Appli" }];
    const { entries } = await (await GET(req(), ctx)).json();
    expect(entries.map((e: { name: string }) => e.name)).toEqual(["Aaron Hors-Appli", "Alice", "Bob"]);
    expect(entries[0]).toMatchObject({ key: "guest:g1", isMember: false, reachable: false });
  });

  it("dit qui est ATTEIGNABLE par notification", async () => {
    // Sans cette information, le capitaine relance en aveugle des gens que la relance
    // n'atteindra jamais.
    h.members = [membre("u1", "Alice", true), membre("u2", "Bob", false)];
    const { entries, counts } = await (await GET(req(), ctx)).json();
    expect(entries.find((e: { name: string }) => e.name === "Alice").reachable).toBe(true);
    expect(entries.find((e: { name: string }) => e.name === "Bob").reachable).toBe(false);
    expect(counts.pendingReachable.map((e: { name: string }) => e.name)).toEqual(["Alice"]);
    expect(counts.pendingUnreachable.map((e: { name: string }) => e.name)).toEqual(["Bob"]);
  });

  it("affiche « relayé par » UNIQUEMENT quand un tiers a saisi", async () => {
    // Sur une réponse de première main, afficher « relayé par Alice » à Alice n'apprendrait
    // rien et sèmerait le doute sur ce qu'elle a elle-même déclaré.
    h.answers = [
      { interclubId: "f1", userId: "u1", guestId: null, status: "yes", comment: null, setById: "u1", setBy: { displayName: "Alice", nickname: null } },
      { interclubId: "f1", userId: "u2", guestId: null, status: "no", comment: "en déplacement", setById: "u1", setBy: { displayName: "Alice", nickname: null } },
    ];
    const { entries } = await (await GET(req(), ctx)).json();
    expect(entries.find((e: { name: string }) => e.name === "Alice").relayedBy).toBeNull();
    expect(entries.find((e: { name: string }) => e.name === "Bob")).toMatchObject({
      status: "no",
      comment: "en déplacement",
      relayedBy: "Alice",
    });
  });

  it("compte les réponses et rappelle le nombre de simples à couvrir", async () => {
    h.answers = [
      { interclubId: "f1", userId: "u1", guestId: null, status: "yes", comment: null, setById: "u1", setBy: { displayName: "Alice", nickname: null } },
    ];
    const { counts, matchCount } = await (await GET(req(), ctx)).json();
    expect(counts).toMatchObject({ yes: 1, no: 0, maybe: 0 });
    expect(matchCount).toBe(4);
  });
});

describe("PUT /api/interclub/{id}/availability", () => {
  it("enregistre ma propre réponse, signée de moi", async () => {
    const res = await PUT(req({ status: "yes", comment: "  je peux  " }), ctx);
    expect(res.status).toBe(200);
    expect(h.created).toMatchObject({
      interclubId: "f1",
      userId: "u1",
      guestId: null,
      status: "yes",
      comment: "je peux",
      setById: "u1",
    });
  });

  it("rend `me`, comme le GET — deux verbes, une seule forme", async () => {
    // L'écran remplace tout son état par ce corps. Sans `me`, plus aucune ligne n'était « moi » :
    // le repère disparaissait et le lien « Ajouter une précision » avec lui, dès la première
    // réponse posée. Deux corps différents pour la même ressource, c'est l'invitation au trou.
    const { me } = await (await PUT(req({ status: "yes" }), ctx)).json();
    expect(me).toBe("u1");
  });

  it("ne touche PAS au commentaire quand la requête n'en porte pas", async () => {
    // Les trois boutons de l'écran envoient un statut seul. Traiter l'absence comme un
    // effacement supprimait « je peux, mais pas avant 20h30 » au passage de « dispo » à
    // « incertain » — c'est-à-dire au moment précis où la précision devenait utile.
    h.answers = [{ interclubId: "f1", id: "a1", guestId: null, userId: "u1", setById: "u1", status: "yes", comment: "pas avant 20h30", updatedAt: new Date() }];
    await PUT(req({ status: "maybe" }), ctx);
    expect(h.updated?.data).toMatchObject({ status: "maybe" });
    expect(h.updated?.data).not.toHaveProperty("comment");
  });

  it("efface le commentaire quand on l'envoie VIDE — absent et vide ne sont pas la même chose", async () => {
    h.answers = [{ interclubId: "f1", id: "a1", guestId: null, userId: "u1", setById: "u1", status: "yes", comment: "pas avant 20h30", updatedAt: new Date() }];
    await PUT(req({ status: "yes", comment: "   " }), ctx);
    expect(h.updated?.data).toMatchObject({ comment: null });
  });

  it("refuse un statut inventé", async () => {
    expect((await PUT(req({ status: "peut-être" }), ctx)).status).toBe(400);
    expect(h.created).toBeNull();
  });

  it("relaie la réponse d'un coéquipier, en gardant QUI l'a saisie", async () => {
    // Le cas qui justifie toute la fonctionnalité : Bob n'a pas activé les notifications, on
    // l'a eu au club, on consigne. `setById` est ce qui distingue « il a dit oui » de « on a
    // dit qu'il dirait oui ».
    await PUT(req({ status: "no", userId: "u2" }), ctx);
    expect(h.created).toMatchObject({ userId: "u2", setById: "u1", status: "no" });
  });

  it("relaie la réponse d'un joueur SANS COMPTE", async () => {
    h.guestById = { g1: { teamId: "t1" } };
    await PUT(req({ status: "yes", guestId: "g1" }), ctx);
    expect(h.created).toMatchObject({ guestId: "g1", userId: null, setById: "u1" });
  });

  it("refuse de répondre pour quelqu'un d'une autre équipe", async () => {
    h.users.u2 = { teamId: "t2" };
    expect((await PUT(req({ status: "yes", userId: "u2" }), ctx)).status).toBe(400);
    expect(h.created).toBeNull();
  });

  it("refuse un `guestId` VIDE, qui traversait toutes les gardes", async () => {
    // `""` est une chaîne, et une chaîne vide est falsy : elle passait le typage puis sautait
    // chaque `if (guestId)` — le refus du couple membre+invité comme le contrôle d'équipe. La
    // ligne partait en base avec `userId` ET `guestId`, soit une violation de clé étrangère et
    // une réponse qui enfreint l'exclusivité des deux colonnes.
    const res = await PUT(req({ status: "yes", guestId: "" }), ctx);
    expect(res.status).toBe(400);
    expect(h.created).toBeNull();
  });

  it("refuse un `guestId` mal typé plutôt que de répondre pour soi-même", async () => {
    expect((await PUT(req({ status: "yes", guestId: 42 }), ctx)).status).toBe(400);
    expect(h.created).toBeNull();
  });

  it("refuse un membre ET un joueur sans compte dans la même requête", async () => {
    const res = await PUT(req({ status: "yes", userId: "u2", guestId: "g1" }), ctx);
    expect(res.status).toBe(400);
    expect(h.created).toBeNull();
  });

  it("409 quand un tiers écrase une réponse de PREMIÈRE MAIN, en disant laquelle", async () => {
    // Le capitaine doit voir ce qu'il remplace. Un refus sec le laisserait croire à un bug ;
    // un remplacement silencieux ferait disparaître un « non » assumé.
    h.answers = [
      { interclubId: "f1", id: "a1", guestId: null, userId: "u2", setById: "u2", status: "no", updatedAt: new Date("2026-10-01T10:00:00Z"), comment: null, setBy: { displayName: "Bob", nickname: null } },
    ];
    const res = await PUT(req({ status: "yes", userId: "u2" }), ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("confirm_override");
    expect(body.existing).toMatchObject({ status: "no" });
    expect(h.updated).toBeNull();
  });

  it("passe avec confirmOverride, et enregistre le nouveau signataire", async () => {
    h.answers = [
      { interclubId: "f1", id: "a1", guestId: null, userId: "u2", setById: "u2", status: "no", updatedAt: new Date(), comment: null, setBy: { displayName: "Bob", nickname: null } },
    ];
    const res = await PUT(req({ status: "yes", userId: "u2", confirmOverride: true }), ctx);
    expect(res.status).toBe(200);
    expect(h.updated?.data).toMatchObject({ status: "yes", setById: "u1" });
  });

  it("l'intéressé se corrige SANS confirmation — c'est sa réponse", async () => {
    h.answers = [
      { interclubId: "f1", id: "a1", guestId: null, userId: "u1", setById: "u1", status: "no", updatedAt: new Date(), comment: null, setBy: { displayName: "Alice", nickname: null } },
    ];
    const res = await PUT(req({ status: "yes" }), ctx);
    expect(res.status).toBe(200);
    expect(h.updated?.data).toMatchObject({ status: "yes" });
  });

  it("remplacer un relais par un autre ne demande rien : deux ouï-dire se valent", async () => {
    h.answers = [
      { interclubId: "f1", id: "a1", guestId: null, userId: "u2", setById: "u3", status: "no", updatedAt: new Date(), comment: null, setBy: { displayName: "Chloé", nickname: null } },
    ];
    expect((await PUT(req({ status: "yes", userId: "u2" }), ctx)).status).toBe(200);
  });

  it("lit la réponse existante DANS la transaction, jamais avant", async () => {
    // Le corps d'une transaction Serializable est REJOUÉ TEL QUEL sur conflit (`http-tx.ts`).
    // Une lecture faite dehors est capturée par la closure : le réessai rejouerait « créer »
    // sur un état déjà périmé, violerait l'unicité `(interclubId, userId)`, et sortirait en
    // `P2002` — que la boucle ne rejoue pas, donc un 500, précisément le cas que cette
    // transaction est là pour éviter. Seul le relevé des réponses de l'écran, qui n'écrit
    // rien, a le droit de passer hors transaction.
    await PUT(req({ status: "yes" }), ctx);
    expect(h.horsTx).toEqual(["findMany"]);
  });

  it("ne confond pas la réponse d'une AUTRE rencontre", async () => {
    // La ligne existe, mais pour la rencontre d'à côté : on doit créer, pas corriger.
    h.answers = [
      { interclubId: "f9", id: "a9", guestId: null, userId: "u1", setById: "u1", status: "no", updatedAt: new Date(), comment: null, setBy: { displayName: "Alice", nickname: null } },
    ];
    await PUT(req({ status: "yes" }), ctx);
    expect(h.created).toMatchObject({ interclubId: "f1", userId: "u1", status: "yes" });
    expect(h.updated).toBeNull();
  });

  it("ne confond pas la réponse de QUELQU'UN D'AUTRE", async () => {
    // Bob a répondu de première main ; Alice répond pour elle-même. Aller chercher la ligne de
    // Bob rendrait un 409 de confirmation sur une réponse qui n'a rien à voir.
    h.answers = [
      { interclubId: "f1", id: "a1", guestId: null, userId: "u2", setById: "u2", status: "no", updatedAt: new Date(), comment: null, setBy: { displayName: "Bob", nickname: null } },
    ];
    const res = await PUT(req({ status: "yes" }), ctx);
    expect(res.status).toBe(200);
    expect(h.created).toMatchObject({ userId: "u1", status: "yes" });
  });

  it("ne confond pas la réponse d'un MEMBRE avec celle d'un joueur sans compte", async () => {
    // `userId` et `guestId` cohabitent dans la même table : c'est le `where` qui les sépare.
    h.guestById = { g1: { teamId: "t1" } };
    h.answers = [
      { interclubId: "f1", id: "a1", guestId: null, userId: "u1", setById: "u1", status: "no", updatedAt: new Date(), comment: null, setBy: { displayName: "Alice", nickname: null } },
    ];
    await PUT(req({ status: "yes", guestId: "g1" }), ctx);
    expect(h.created).toMatchObject({ guestId: "g1", userId: null });
    expect(h.updated).toBeNull();
  });

  it("403 pour un membre d'une autre équipe, comme en lecture", async () => {
    h.users.u1 = { teamId: "t2" };
    expect((await PUT(req({ status: "yes" }), ctx)).status).toBe(403);
    expect(h.created).toBeNull();
  });
});
