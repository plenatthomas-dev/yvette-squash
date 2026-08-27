import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  session: null as null | { userId: string },
  configured: true,
  devices: 1,
  sent: 1,
  target: null as null | string,
  payload: null as null | Record<string, unknown>,
}));

vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/db", () => ({
  prisma: { pushSubscription: { count: vi.fn(async () => h.devices) } },
}));
vi.mock("@/lib/push", () => ({
  pushConfigured: vi.fn(() => h.configured),
  pushToUser: vi.fn(async (userId: string, payload: Record<string, unknown>) => {
    h.target = userId;
    h.payload = payload;
    return h.sent;
  }),
}));

import { POST } from "./route";

const req = () => ({ cookies: { get: () => undefined } }) as unknown as NextRequest;

beforeEach(() => {
  h.session = { userId: "u1" };
  h.configured = true;
  h.devices = 1;
  h.sent = 1;
  h.target = null;
  h.payload = null;
});

describe("POST /api/push/test", () => {
  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await POST(req())).status).toBe(401);
  });

  it("503 quand l'environnement n'a pas de clés", async () => {
    h.configured = false;
    expect((await POST(req())).status).toBe(503);
  });

  it("ne vise QUE le membre courant, jamais un identifiant reçu du client", async () => {
    await POST(req());
    expect(h.target).toBe("u1");
  });

  it("distingue « aucun appareil » de « envoyé »", async () => {
    h.devices = 0;
    const vide = await (await POST(req())).json();
    expect(vide).toMatchObject({ devices: 0, sent: 0 });

    h.devices = 2;
    h.sent = 2;
    const plein = await (await POST(req())).json();
    expect(plein).toMatchObject({ devices: 2, sent: 2 });
  });

  it("sonne même en la répétant, et n'écrase aucune vraie notification", async () => {
    await POST(req());
    expect(h.payload).toMatchObject({ tag: "push-test", renotify: true });
  });
});
