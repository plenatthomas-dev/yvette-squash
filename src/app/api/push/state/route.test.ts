import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  session: null as null | { userId: string },
  upserts: [] as Record<string, unknown>[],
  purge: vi.fn(async () => ({ count: 0 })),
}));

vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    notifDeviceState: {
      upsert: vi.fn(async (args: Record<string, unknown>) => {
        h.upserts.push(args);
        return {};
      }),
      deleteMany: (...a: unknown[]) => h.purge(...(a as [])),
    },
  },
}));

import { POST } from "./route";

const ID = "0b9f3c1e-7a42-4d55-9a0e-2c6f8e1d4b77";
const req = (body: unknown) =>
  ({ cookies: { get: () => undefined }, json: async () => body }) as unknown as NextRequest;

beforeEach(() => {
  h.session = { userId: "u1" };
  h.upserts = [];
  h.purge.mockClear();
  h.purge.mockResolvedValue({ count: 0 });
});

describe("POST /api/push/state", () => {
  const releve = { deviceId: ID, permission: "denied", subscribed: false, platform: "android-app" };

  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await POST(req(releve))).status).toBe(401);
    expect(h.upserts).toHaveLength(0);
  });

  it("400 sur un relevé hors des valeurs connues", async () => {
    expect((await POST(req({ ...releve, permission: "prompt" }))).status).toBe(400);
    expect(h.upserts).toHaveLength(0);
  });

  it("range l'appareil sous le compte de la SESSION, jamais sous un identifiant du corps", async () => {
    await POST(req({ ...releve, userId: "intrus" }));
    const u = h.upserts[0] as { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> };
    expect(u.where).toEqual({ deviceId: ID });
    expect(u.create.userId).toBe("u1");
    expect(u.update.userId).toBe("u1");
  });

  it("rafraîchit la date même quand rien n'a changé — c'est elle qui garde l'appareil dans la fenêtre", async () => {
    await POST(req(releve));
    const u = h.upserts[0] as { update: { updatedAt?: unknown } };
    expect(u.update.updatedAt).toBeInstanceOf(Date);
  });

  it("une purge en échec ne fait pas échouer le relevé", async () => {
    h.purge.mockRejectedValue(new Error("base lente"));
    const res = await POST(req(releve));
    expect(res.status).toBe(200);
    expect(h.purge).toHaveBeenCalledTimes(1);
  });
});
