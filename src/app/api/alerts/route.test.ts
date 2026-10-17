import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// POST /api/alerts — ce qui entre en base est relu toutes les ~4 minutes par le cron
// check-alerts. Une valeur seulement BIEN FORMÉE (« 12:75 », « 2026-10-32 ») y faisait lever
// `toInstant` hors de tout `try` : le cron tombait à chaque passage, pour tout le club, et
// l'alerte fautive n'expirait jamais. Ces tests verrouillent l'entrée ; le cron, lui, sait
// désormais survivre à une ligne illisible déjà présente (cf. check-alerts/route.test.ts).

const h = vi.hoisted(() => ({
  session: null as null | { userId: string },
  actives: 0,
  count: vi.fn(),
  upsert: vi.fn(),
  alertsChanged: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/db", () => ({
  prisma: { slotAlert: { count: h.count, upsert: h.upsert } },
}));
// Mock PARTIEL, comme dans le test du cron : les vraies bornes de date (heure du club), seul
// ce qui touche au cache Next est remplacé.
vi.mock("@/lib/alerts-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/alerts-gate")>()),
  alertsChanged: h.alertsChanged,
}));

import { POST } from "./route";
import { alertTodayISO } from "@/lib/alerts-gate";

const post = (body: unknown) =>
  ({ cookies: { get: () => undefined }, json: async () => body }) as unknown as NextRequest;

/** Demain, en heure du club : toujours dans la fenêtre [aujourd'hui, horizon]. */
const demain = () => {
  const d = new Date(`${alertTodayISO()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

beforeEach(() => {
  h.session = { userId: "u1" };
  h.actives = 0;
  h.count.mockReset().mockImplementation(async () => h.actives);
  h.upsert.mockReset().mockImplementation(async ({ create }) => ({ id: "a1", ...create }));
  h.alertsChanged.mockReset();
});

describe("POST /api/alerts — validation", () => {
  it("401 si non authentifié", async () => {
    h.session = null;
    expect((await POST(post({ date: demain(), hm: "18:00" }))).status).toBe(401);
  });

  it("accepte un créneau réel et ouvre la porte du cron", async () => {
    const res = await POST(post({ date: demain(), hm: "18:00" }));
    expect(res.status).toBe(200);
    expect(h.upsert).toHaveBeenCalledTimes(1);
    expect(h.alertsChanged).toHaveBeenCalled();
  });

  it.each(["12:75", "99:99", "24:00", "7:00", "18h00", "", 1800])(
    "refuse l'horaire impossible %j sans rien écrire",
    async (hm) => {
      const res = await POST(post({ date: demain(), hm }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Horaire invalide");
      expect(h.upsert).not.toHaveBeenCalled();
    },
  );

  it.each(["00:00", "09:40", "23:59"])("accepte l'horaire %s", async (hm) => {
    expect((await POST(post({ date: demain(), hm }))).status).toBe(200);
  });

  // Les bornes passé/horizon sont des comparaisons de CHAÎNES : « 2026-10-32 » ou « 2026-13-01 »
  // les franchissait dès lors qu'il tombait dans l'intervalle lexicographique.
  it("refuse un jour qui n'existe pas, même dans la fenêtre lexicographique", async () => {
    const [y, m] = alertTodayISO().split("-");
    for (const date of [`${y}-${m}-32`, `${y}-02-31`, `${y}-13-01`, "2026-1-05", 20261017]) {
      const res = await POST(post({ date, hm: "18:00" }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Date invalide");
    }
    expect(h.upsert).not.toHaveBeenCalled();
  });
});

describe("POST /api/alerts — plafond d'alertes actives", () => {
  it("refuse la 21ᵉ alerte active avec un message explicite, sans rien écrire", async () => {
    h.actives = 20;
    const res = await POST(post({ date: demain(), hm: "18:00" }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/20 alertes en cours/);
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.alertsChanged).not.toHaveBeenCalled();
  });

  it("accepte tant qu'on est sous le plafond", async () => {
    h.actives = 19;
    expect((await POST(post({ date: demain(), hm: "18:00" }))).status).toBe(200);
  });

  it("compte MES alertes actives sur les AUTRES créneaux (réactiver celle-ci reste permis)", async () => {
    const date = demain();
    await POST(post({ date, hm: "18:00" }));
    expect(h.count).toHaveBeenCalledWith({
      where: { userId: "u1", active: true, NOT: { date, hm: "18:00" } },
    });
  });
});
