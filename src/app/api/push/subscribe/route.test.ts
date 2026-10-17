import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// POST /api/push/subscribe — l'endpoint enregistré ici est l'URL vers laquelle nos crons
// posteront ensuite, signés VAPID, à chaque notification. « Commence par https:// » laissait un
// membre y écrire n'importe quel hôte. Et le nombre d'appareils par membre était illimité.

const h = vi.hoisted(() => ({
  session: null as null | { userId: string },
  upsert: vi.fn(),
  findMany: vi.fn(),
  deleteMany: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    pushSubscription: { upsert: h.upsert, findMany: h.findMany, deleteMany: h.deleteMany },
  },
}));

import { POST } from "./route";

const post = (body: unknown) =>
  ({ cookies: { get: () => undefined }, json: async () => body }) as unknown as NextRequest;
const KEYS = { p256dh: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9", auth: "tBHItJI5svbpez7KI4CCXg" };
const sub = (endpoint: string) => post({ endpoint, keys: KEYS });

beforeEach(() => {
  h.session = { userId: "u1" };
  h.upsert.mockReset().mockResolvedValue({});
  h.findMany.mockReset().mockResolvedValue([]);
  h.deleteMany.mockReset().mockResolvedValue({ count: 0 });
});

describe("POST /api/push/subscribe — services push reconnus", () => {
  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await POST(sub("https://fcm.googleapis.com/fcm/send/abc"))).status).toBe(401);
  });

  it.each([
    "https://fcm.googleapis.com/fcm/send/dX1y:APA91b", // Chrome, Samsung Internet, Opera, Brave…
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAAA", // Firefox
    "https://wns2-par02p.notify.windows.com/w/?token=BQYAAA", // Edge
    "https://web.push.apple.com/QGuQyavXutnMH", // Safari macOS / iOS
    "https://FCM.googleapis.com/fcm/send/abc", // casse normalisée par `new URL`
  ])("accepte %s", async (endpoint) => {
    expect((await POST(sub(endpoint))).status).toBe(200);
    expect(h.upsert).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://evil.example/fcm.googleapis.com/x", // le nom du service dans le CHEMIN
    "https://fcm.googleapis.com.evil.example/x", // le nom du service en PRÉFIXE d'hôte
    "https://fcm.googleapis.com@evil.example/x", // identifiants d'URL : l'hôte réel est evil.example
    "https://evilnotify.windows.com/x", // suffixe sans le point de sous-domaine
    "https://fcm.googleapis.com:8443/fcm/send/x", // port non standard
    "http://fcm.googleapis.com/fcm/send/x", // pas https
    "https://169.254.169.254/latest/meta-data", // SSRF classique
    "https://android.googleapis.com/gcm/send/x", // GCM, éteint
    "pas une url",
  ])("refuse %s sans rien écrire", async (endpoint) => {
    expect((await POST(sub(endpoint))).status).toBe(400);
    expect(h.upsert).not.toHaveBeenCalled();
  });
});

describe("POST /api/push/subscribe — plafond de 10 appareils par membre", () => {
  it("supprime les plus anciens au-delà, en épargnant l'appareil courant", async () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/courant";
    h.findMany.mockResolvedValue([{ id: "vieux1" }, { id: "vieux2" }]);
    const res = await POST(sub(endpoint));
    expect(res.status).toBe(200);
    // Les 9 autres plus récents sont gardés (+ le courant = 10) ; le reste part.
    expect(h.findMany).toHaveBeenCalledWith({
      where: { userId: "u1", NOT: { endpoint } },
      orderBy: { createdAt: "desc" },
      skip: 9,
      select: { id: true },
    });
    expect(h.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["vieux1", "vieux2"] } } });
  });

  it("ne supprime rien sous le plafond", async () => {
    await POST(sub("https://fcm.googleapis.com/fcm/send/x"));
    expect(h.deleteMany).not.toHaveBeenCalled();
  });

  it("un échec du ménage ne fait pas croire l'abonnement raté", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    h.findMany.mockRejectedValue(new Error("base injoignable"));
    const res = await POST(sub("https://fcm.googleapis.com/fcm/send/x"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
