import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// LE CONTRÔLE D'ACCÈS SE TESTE DANS LES DEUX SENS, toujours. Une garde vérifiée seulement
// « à l'endroit » (le capitaine passe) laisse passer l'inverse (tout le monde passe) sans que
// rien ne le signale — et c'est précisément ce qu'une garde est censée empêcher.
const h = vi.hoisted(() => ({
  interclub: true,
  session: null as null | { userId: string; email: string | null; displayName: string },
  /** Les équipes dont le membre courant est capitaine, telles que la base les rend. */
  teams: [] as { id: string; name: string }[],
  adminEmails: "admin@ex.com",
  findMany: vi.fn(),
}));

vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({
    tricount: false,
    emailLogin: false,
    biometry: false,
    directory: false,
    delegation: false,
    tournament: false,
    ranking: false,
    interclub: h.interclub,
    forum: false,
    externalBookings: false,
  }),
}));
// On ne remplace QUE `getSession` : `admin.ts` importe `normalizeEmail` du même module, et un
// mock qui l'efface ferait échouer l'allowlist pour une raison qui n'a rien à voir avec ce
// qu'on teste ici.
vi.mock("@/lib/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/session")>()),
  getSession: vi.fn(async () => h.session),
}));
// `isAdminEmail` reste le VRAI code : c'est lui qui décide du filet, et le mocker rendrait le
// test aveugle à un changement de règle d'allowlist.
vi.mock("@/lib/db", () => ({
  prisma: { interclubTeam: { findMany: (...a: unknown[]) => h.findMany(...a) } },
}));

import { requireCaptain, requireCaptainOf, captainTeams } from "./captain-access";

const req = () => ({ cookies: { get: () => undefined } }) as unknown as NextRequest;

const membre = (userId = "u1", email: string | null = "jean@ex.com") => ({
  userId,
  email,
  displayName: "Jean Dupont",
});

beforeEach(() => {
  process.env.ADMIN_EMAILS = h.adminEmails;
  h.interclub = true;
  h.session = membre();
  h.teams = [];
  h.findMany.mockReset().mockImplementation(async () => h.teams);
});

describe("l'ordre des trois contrôles", () => {
  // Le flag D'ABORD : une fonction coupée doit répondre « cette route n'existe pas ici », y
  // compris à un visiteur non connecté. Un 401 lui révélerait qu'il y a quelque chose à cette
  // adresse — c'est la règle que `requireInterclubMember` applique déjà, mot pour mot.
  it("fonction coupée → 404, MÊME sans session, et sans lire la base", async () => {
    h.interclub = false;
    h.session = null;
    const r = await requireCaptain(req());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(404);
    expect(h.findMany).not.toHaveBeenCalled();
  });

  it("sans session → 401", async () => {
    h.session = null;
    const r = await requireCaptain(req());
    if (!r.ok) expect(r.response.status).toBe(401);
    else expect.unreachable();
  });

  // 403 et 401 disent deux choses différentes : « je ne sais pas qui tu es » appelle une
  // reconnexion, « ce n'est pas pour toi » n'appelle rien du tout.
  it("membre connecté mais capitaine de rien → 403, pas 401", async () => {
    h.teams = [];
    const r = await requireCaptain(req());
    if (!r.ok) expect(r.response.status).toBe(403);
    else expect.unreachable();
  });
});

describe("requireCaptain", () => {
  it("capitaine d'une équipe → passe, avec SES équipes", async () => {
    h.teams = [{ id: "t1", name: "Équipe 1" }];
    const r = await requireCaptain(req());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r).toMatchObject({ teamIds: ["t1"], isAdmin: false });
  });

  it("capitaine de DEUX équipes → les deux (le capitanat appartient à l'équipe)", async () => {
    h.teams = [
      { id: "t1", name: "Équipe 1" },
      { id: "t2", name: "Équipe 2" },
    ];
    const r = await requireCaptain(req());
    if (r.ok) expect(r.teamIds).toEqual(["t1", "t2"]);
    else expect.unreachable();
  });

  // Le filet du soir où le capitaine est injoignable et où la ligue attend un score.
  it("un admin passe même sans être capitaine, avec une liste VIDE", async () => {
    h.session = membre("adm", "admin@ex.com");
    h.teams = [];
    const r = await requireCaptain(req());
    expect(r.ok).toBe(true);
    // Vide, et non « toutes les équipes » : sinon `teamIds` voudrait dire deux choses
    // différentes selon qui appelle, et les routes de liste ne sauraient plus le lire.
    if (r.ok) expect(r).toMatchObject({ teamIds: [], isAdmin: true });
  });

  it("ne cherche QUE les équipes de ce membre", async () => {
    h.teams = [{ id: "t1", name: "Équipe 1" }];
    await requireCaptain(req());
    expect(h.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { captainId: "u1" } }),
    );
  });
});

describe("requireCaptainOf — la portée est l'ÉQUIPE, jamais le club", () => {
  beforeEach(() => {
    h.teams = [{ id: "t1", name: "Équipe 1" }];
  });

  it("sur SON équipe → passe", async () => {
    const r = await requireCaptainOf(req(), "t1");
    expect(r.ok).toBe(true);
  });

  // LE test de ce module. L'accès fédéral d'un capitaine ne couvre que son équipe : une portée
  // plus large dans l'appli promettrait un geste qui échouerait au bout du chemin.
  it("sur l'équipe D'À CÔTÉ → 403, alors même qu'il est bien capitaine", async () => {
    const r = await requireCaptainOf(req(), "t2");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });

  it("un admin passe sur n'importe quelle équipe", async () => {
    h.session = membre("adm", "admin@ex.com");
    h.teams = [];
    const r = await requireCaptainOf(req(), "t2");
    expect(r.ok).toBe(true);
  });

  it("fonction coupée → 404 même pour le capitaine de l'équipe visée", async () => {
    h.interclub = false;
    const r = await requireCaptainOf(req(), "t1");
    if (!r.ok) expect(r.response.status).toBe(404);
    else expect.unreachable();
  });
});

describe("captainTeams", () => {
  it("rend les équipes dans l'ordre d'affichage du club", async () => {
    h.teams = [{ id: "t1", name: "Équipe 1" }];
    await captainTeams("u1");
    expect(h.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { order: "asc" } }),
    );
  });
});
