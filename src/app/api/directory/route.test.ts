import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// État mutable partagé, hoisté pour être visible des factories vi.mock (hoistées en tête).
const h = vi.hoisted(() => ({
  flags: { FEATURE_DIRECTORY: true, FEATURE_RANKING: true },
  session: null as null | { userId: string },
  users: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/features", () => ({
  get FEATURE_DIRECTORY() {
    return h.flags.FEATURE_DIRECTORY;
  },
  get FEATURE_RANKING() {
    return h.flags.FEATURE_RANKING;
  },
}));
vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/db", () => ({
  prisma: { user: { findMany: vi.fn(async () => h.users) } },
}));

import { GET } from "./route";

// La route ne lit que req.cookies.get("sid") → un faux minimal suffit.
const req = () => ({ cookies: { get: () => undefined } }) as unknown as NextRequest;

beforeEach(() => {
  h.flags = { FEATURE_DIRECTORY: true, FEATURE_RANKING: true };
  h.session = { userId: "u1" };
  h.users = [];
});

describe("GET /api/directory", () => {
  it("404 si l'annuaire est désactivé", async () => {
    h.flags.FEATURE_DIRECTORY = false;
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

  it("expose clt/rang/cat quand FEATURE_RANKING est actif et le rapprochement existe", async () => {
    h.users = [
      { id: "a", displayName: "Alice Martin", nickname: null, squashnetRanking: { clt: "5A", rang: 3184, cat: "+55" } },
      { id: "b", displayName: "Bob Sans", nickname: null, squashnetRanking: null },
    ];
    const res = await GET(req());
    const { members } = await res.json();
    expect(members[0]).toMatchObject({ name: "Alice Martin", clt: "5A", rang: 3184, cat: "+55" });
    expect(members[1].clt).toBeUndefined(); // pas de rapprochement → aucun champ classement
  });

  it("n'expose jamais le classement quand FEATURE_RANKING est désactivé", async () => {
    h.flags.FEATURE_RANKING = false;
    h.users = [
      { id: "a", displayName: "Alice Martin", nickname: null, squashnetRanking: { clt: "5A", rang: 3184, cat: "+55" } },
    ];
    const res = await GET(req());
    const { members } = await res.json();
    expect(members[0].clt).toBeUndefined();
    expect(members[0].rang).toBeUndefined();
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
});
