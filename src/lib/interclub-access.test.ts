import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  interclub: true,
  session: null as null | { userId: string; displayName: string; email: string | null },
  sidVu: undefined as string | undefined,
}));

vi.mock("./features-server", () => ({
  getFeatures: vi.fn(async () => ({ interclub: h.interclub })),
}));
vi.mock("./session", () => ({
  getSession: vi.fn(async (sid: string | undefined) => {
    h.sidVu = sid;
    return h.session;
  }),
}));

import { interclubDisabledResponse, requireInterclubMember } from "./interclub-access";

/** Requête minimale : seul le cookie `sid` est lu par la garde. */
function req(sid?: string) {
  return { cookies: { get: (n: string) => (n === "sid" && sid ? { value: sid } : undefined) } } as never;
}

beforeEach(() => {
  h.interclub = true;
  h.session = { userId: "u1", displayName: "Tom", email: "tom@example.com" };
  h.sidVu = undefined;
});

describe("requireInterclubMember", () => {
  it("laisse passer un membre connecté et rend sa session", async () => {
    const a = await requireInterclubMember(req("abc"));
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.session.userId).toBe("u1");
    expect(h.sidVu).toBe("abc");
  });

  it("répond 401 sans session", async () => {
    h.session = null;
    const a = await requireInterclubMember(req("périmé"));
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.response.status).toBe(401);
  });

  it("répond 404 quand la fonction est coupée", async () => {
    h.interclub = false;
    const a = await requireInterclubMember(req("abc"));
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.response.status).toBe(404);
  });

  it("le flag l'emporte sur la session : un visiteur non connecté voit 404, pas 401", async () => {
    // Sinon le 401 révélerait qu'il existe quelque chose à cette adresse — sur un
    // environnement où la fonction est justement censée ne pas exister.
    h.interclub = false;
    h.session = null;
    const a = await requireInterclubMember(req());
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.response.status).toBe(404);
  });

  it("ne consulte même pas la session quand la fonction est coupée", async () => {
    h.interclub = false;
    await requireInterclubMember(req("abc"));
    expect(h.sidVu).toBeUndefined(); // getSession n'a pas été appelé → pas de lecture Postgres
  });
});

describe("interclubDisabledResponse", () => {
  it("rend null quand la fonction est active", async () => {
    expect(await interclubDisabledResponse()).toBeNull();
  });

  it("rend un 404 quand elle est coupée", async () => {
    h.interclub = false;
    const res = await interclubDisabledResponse();
    expect(res?.status).toBe(404);
  });
});
