import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// État mutable partagé, hoisté pour être visible des factories vi.mock (hoistées en tête).
const h = vi.hoisted(() => ({
  flags: { directory: true, ranking: true, interclub: true },
  session: null as null | { userId: string },
  users: [] as Array<Record<string, unknown>>,
}));

// Les flags sont résolus à chaud côté serveur (env + override en base) : on mocke l'état effectif.
vi.mock("@/lib/features-server", () => ({
  getFeatures: async () => ({
    tricount: false,
    emailLogin: false,
    directory: h.flags.directory,
    delegation: false,
    tournament: false,
    ranking: h.flags.ranking,
    interclub: h.flags.interclub,
  }),
}));
vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/db", () => ({
  prisma: { user: { findMany: vi.fn(async () => h.users) } },
}));

import { GET } from "./route";

// La route ne lit que req.cookies.get("sid") → un faux minimal suffit.
const req = () => ({ cookies: { get: () => undefined } }) as unknown as NextRequest;

beforeEach(() => {
  h.flags = { directory: true, ranking: true, interclub: true };
  h.session = { userId: "u1" };
  h.users = [];
});

describe("GET /api/directory", () => {
  it("404 si l'annuaire est désactivé", async () => {
    h.flags.directory = false;
    const res = await GET(req());
    expect(res.status).toBe(404);
  });

  it("401 si non authentifié", async () => {
    h.session = null;
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("mappe pseudo > nom réel et trie alphabétiquement (insensible casse/accents)", async () => {
    h.users = [
      { id: "b", displayName: "Zoé Zola", nickname: null },
      { id: "a", displayName: "Alice Martin", nickname: null },
      { id: "c", displayName: "Bruno Durand", nickname: "Bubu" },
    ];
    const res = await GET(req());
    const { members } = await res.json();
    expect(members.map((m: { name: string }) => m.name)).toEqual(["Alice Martin", "Bubu", "Zoé Zola"]);
  });

  it("expose clt/rang/rangM/cat quand le classement est actif et le rapprochement existe", async () => {
    h.users = [
      {
        id: "a",
        displayName: "Alice Martin",
        nickname: null,
        squashnetRanking: { clt: "5A", rang: 3184, rangM: 412, cat: "+55" },
      },
      { id: "b", displayName: "Bob Sans", nickname: null, squashnetRanking: null },
    ];
    const res = await GET(req());
    const { members } = await res.json();
    expect(members[0]).toMatchObject({
      name: "Alice Martin",
      clt: "5A",
      rang: 3184,
      rangM: 412, // le nombre affiché et trié dans l'annuaire
      cat: "+55",
    });
    expect(members[1].clt).toBeUndefined(); // pas de rapprochement → aucun champ classement
  });

  it("expose la correction admin (interclubCltOverride) quand il n'y a pas de rapprochement squashnet", async () => {
    h.users = [
      { id: "a", displayName: "Alice Martin", nickname: null, interclubCltOverride: "4D", squashnetRanking: null },
    ];
    const res = await GET(req());
    const { members } = await res.json();
    expect(members[0].clt).toBe("4D");
    expect(members[0].rang).toBeUndefined();
    expect(members[0].rangM).toBeUndefined();
  });

  it("expose la correction admin du RANG MIXTE, comme celle du classement", async () => {
    // Depuis que l'ordre des simples interclub s'appuie sur le rang mixte, un admin peut en
    // forcer un. Le taire ici trierait un membre corrigé à une place que plus rien ne justifie.
    h.users = [
      {
        id: "a",
        displayName: "Alice Martin",
        nickname: null,
        interclubCltOverride: "4D",
        interclubRangMOverride: 812,
        squashnetRanking: null,
      },
    ];
    const { members } = await (await GET(req())).json();
    expect(members[0]).toMatchObject({ clt: "4D", rangM: 812 });
    // `rang` (le rang DANS SON GENRE) et `cat` ne se corrigent nulle part : aucun écran ne les
    // demande, et ils ne servent qu'aux têtes de série et à une info-bulle.
    expect(members[0].rang).toBeUndefined();
  });

  it("la correction du rang mixte l'emporte sur le rapprochement", async () => {
    h.users = [
      {
        id: "a",
        displayName: "Alice Martin",
        nickname: null,
        interclubCltOverride: null,
        interclubRangMOverride: 812,
        squashnetRanking: { clt: "3A", rang: 10, rangM: 20, cat: "+45" },
      },
    ];
    const { members } = await (await GET(req())).json();
    expect(members[0]).toMatchObject({ clt: "3A", rangM: 812, rang: 10 });
  });

  it("priorise la correction admin sur le rapprochement squashnet, mais garde le rang de squashnet", async () => {
    h.users = [
      {
        id: "a",
        displayName: "Alice Martin",
        nickname: null,
        interclubCltOverride: "4D",
        squashnetRanking: { clt: "3A", rang: 10, rangM: 20, cat: "+45" },
      },
    ];
    const res = await GET(req());
    const { members } = await res.json();
    expect(members[0]).toMatchObject({ clt: "4D", rang: 10, rangM: 20, cat: "+45" });
  });

  it("n'expose jamais le classement quand le classement est désactivé", async () => {
    h.flags.ranking = false;
    h.users = [
      {
        id: "a",
        displayName: "Alice Martin",
        nickname: null,
        squashnetRanking: { clt: "5A", rang: 3184, rangM: 412, cat: "+55" },
      },
    ];
    const res = await GET(req());
    const { members } = await res.json();
    expect(members[0].clt).toBeUndefined();
    expect(members[0].rang).toBeUndefined();
    expect(members[0].rangM).toBeUndefined();
  });

  it("n'expose jamais email ni contactId", async () => {
    h.users = [{ id: "a", displayName: "Alice Martin", nickname: null }];
    const res = await GET(req());
    const { members } = await res.json();
    expect(Object.keys(members[0]).sort()).toEqual(["id", "name"]);
  });

  it("groupUrl = null quand WHATSAPP_GROUP_URL n'est pas configurée", async () => {
    delete process.env.WHATSAPP_GROUP_URL;
    const res = await GET(req());
    const { groupUrl } = await res.json();
    expect(groupUrl).toBeNull();
  });

  it("expose groupUrl quand configurée en https", async () => {
    process.env.WHATSAPP_GROUP_URL = "https://chat.whatsapp.com/AbCdEf";
    const res = await GET(req());
    const { groupUrl } = await res.json();
    expect(groupUrl).toBe("https://chat.whatsapp.com/AbCdEf");
    delete process.env.WHATSAPP_GROUP_URL;
  });

  it("ignore une WHATSAPP_GROUP_URL non-https (anti-lien douteux)", async () => {
    process.env.WHATSAPP_GROUP_URL = "http://chat.whatsapp.com/AbCdEf";
    const res = await GET(req());
    const { groupUrl } = await res.json();
    expect(groupUrl).toBeNull();
    delete process.env.WHATSAPP_GROUP_URL;
  });

  it("expose l'équipe interclub d'un membre aligné", async () => {
    h.users = [{ id: "a", displayName: "Alice", nickname: null, team: { id: "t1", name: "Équipe 1" } }];
    const { members } = await (await GET(req())).json();
    expect(members[0].team).toBe("Équipe 1");
  });

  it("n'expose aucune équipe pour un membre non aligné", async () => {
    h.users = [{ id: "a", displayName: "Alice", nickname: null, team: null }];
    const { members } = await (await GET(req())).json();
    expect(members[0].team).toBeUndefined();
  });

  it("tait l'équipe quand l'interclub est désactivé, même si la donnée existe", async () => {
    h.flags.interclub = false;
    h.users = [{ id: "a", displayName: "Alice", nickname: null, team: { id: "t1", name: "Équipe 1" } }];
    const { members } = await (await GET(req())).json();
    expect(members[0].team).toBeUndefined();
  });
});
