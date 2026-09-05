import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// LA SIGNATURE D'ENTRÉE SUR LE CANAL DU FIL.
//
// Cette route est le seul endroit du module qui puisse DIVULGUER quelque chose. Sur un canal
// de présence, la fiche que le serveur signe pour un membre est lisible par TOUS les autres
// abonnés — c'est le principe même de « qui est en ligne ». Y glisser l'e-mail publierait
// l'annuaire des adresses du club à quiconque ouvre la console du navigateur.
//
// Le reste vérifie que l'accès reste réservé aux membres (c'est cette signature qui tient la
// porte : la clé publique, elle, est dans le code de la page) et que l'absence de courtier est
// traitée comme un mode dégradé, pas comme une panne.

const h = vi.hoisted(() => ({
  forumOn: true,
  session: {
    userId: "u1",
    displayName: "Thomas",
    email: "membre@example.com",
  } as { userId: string; displayName: string; email: string | null } | null,
  /** Ce que le module de courtier a reçu : [socketId, channel, user]. */
  vu: null as null | [string, string, { id: string; name: string }],
  /** `null` simule un courtier non configuré (ni clé, ni cluster). */
  auth: { auth: "key:signature" } as null | { auth: string },
}));

vi.mock("@/lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session")>()),
  getSession: vi.fn(async () => h.session),
}));
vi.mock("@/lib/features-server", () => ({ getFeatures: async () => ({ forum: h.forumOn }) }));
vi.mock("@/lib/forum-realtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/forum-realtime")>()),
  authorizeForumChannel: vi.fn(
    (socketId: string, channel: string, user: { id: string; name: string }) => {
      h.vu = [socketId, channel, user];
      return h.auth;
    },
  ),
}));

import { POST } from "./route";

/** Le client Pusher poste du form-urlencoded, jamais du JSON : on imite exactement ça. */
const req = (champs: Record<string, string> = {}) => {
  const form = new FormData();
  for (const [k, v] of Object.entries({
    socket_id: "123.456",
    channel_name: "presence-forum",
    ...champs,
  })) {
    form.set(k, v);
  }
  return {
    cookies: { get: () => ({ value: "sid" }) },
    formData: async () => form,
  } as unknown as NextRequest;
};

beforeEach(() => {
  vi.clearAllMocks();
  h.forumOn = true;
  h.session = { userId: "u1", displayName: "Thomas", email: "membre@example.com" };
  h.vu = null;
  h.auth = { auth: "key:signature" };
});

describe("POST /api/forum/realtime-auth", () => {
  it("404 quand la fonction est coupée, avant de regarder la session", async () => {
    h.forumOn = false;
    h.session = null;
    expect((await POST(req())).status).toBe(404);
  });

  it("401 quand personne n'est connecté — c'est cette route qui tient la porte du canal", async () => {
    h.session = null;
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(h.vu).toBeNull();
  });

  it("signe l'entrée d'un membre et rend la signature telle quelle", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ auth: "key:signature" });
  });

  // ⚠️ LE TEST QUI PROTÈGE LA PRÉSENCE. Ce que le serveur signe est lisible par tous les
  // abonnés du canal : seuls l'identifiant et le nom d'affichage, jamais l'adresse e-mail.
  it("ne transmet QUE l'identifiant et le nom d'affichage, JAMAIS l'e-mail", async () => {
    await POST(req());
    expect(h.vu?.[2]).toEqual({ id: "u1", name: "Thomas" });
    expect(JSON.stringify(h.vu)).not.toContain("membre@example.com");
  });

  // Une signature n'a de sens que pour le canal demandé. Refuser tout autre nom dès
  // maintenant évite qu'elle serve ailleurs le jour où un second canal apparaîtra.
  it("403 sur tout autre canal que celui du fil", async () => {
    const res = await POST(req({ channel_name: "presence-autre-chose" }));
    expect(res.status).toBe(403);
    expect(h.vu).toBeNull();
  });

  it("400 quand le corps ne porte pas ce que le client Pusher envoie", async () => {
    const nu = {
      cookies: { get: () => ({ value: "sid" }) },
      formData: async () => new FormData(),
    } as unknown as NextRequest;
    expect((await POST(nu)).status).toBe(400);
  });

  it("400 plutôt qu'une exception quand le corps n'est pas lisible", async () => {
    const casse = {
      cookies: { get: () => ({ value: "sid" }) },
      formData: async () => {
        throw new Error("pas du form-data");
      },
    } as unknown as NextRequest;
    expect((await POST(casse)).status).toBe(400);
  });

  // Clés absentes en développement, quota dépassé, panne : ce n'est pas une erreur du membre.
  // L'écran doit s'en passer et retomber sur le push et le retour au premier plan.
  it("503 quand le courtier n'est pas configuré — un mode dégradé, pas une panne", async () => {
    h.auth = null;
    const res = await POST(req());
    expect(res.status).toBe(503);
  });
});
