// LE RELEVÉ DES NOTIFICATIONS — sur une vraie base.
//
// Trois promesses qu'un faux client ne peut pas éprouver, parce qu'elles tiennent à ce que
// Postgres fait des clauses : la purge n'efface QUE les appareils muets depuis plus de
// NOTIF_STATE_RETENTION_DAYS (une clause trop large viderait la mesure sans que rien ne le
// montre) ; un relevé inchangé rafraîchit quand même la date ; et le tableau de bord ne compte
// que les appareils récents de comptes actifs.
//
// Le préambule (garde-fou de base jetable, mode d'emploi du conteneur) vit dans `pg-harness.ts`.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";
import { SANS_BASE, ouvrirBaseDeTest } from "@/lib/pg-harness";
import { NOTIF_STATE_RETENTION_DAYS } from "@/lib/retention";

const h = vi.hoisted(() => ({ session: null as null | { userId: string } }));
vi.mock("@/lib/session", () => ({ getSession: vi.fn(async () => h.session) }));

type Prisma = import("@prisma/client").PrismaClient;
let prisma: Prisma;
let POST: typeof import("./route").POST;

const MARQUEUR = "PG-TEST-notif-state";
const JOUR = 86_400_000;
let actif = "";
let desactive = "";

const appareil = (n: number) => `pgtest-notif-${String(n).padStart(4, "0")}-aaaaaaaa`;
const req = (body: unknown) =>
  ({ cookies: { get: () => undefined }, json: async () => body }) as unknown as NextRequest;
const releve = (deviceId: string, permission = "denied") => ({
  deviceId,
  permission,
  subscribed: false,
  platform: "android-app",
});

async function vieillir(deviceId: string, jours: number) {
  await prisma.$executeRaw`UPDATE "NotifDeviceState" SET "updatedAt" = ${new Date(Date.now() - jours * JOUR)} WHERE "deviceId" = ${deviceId}`;
}
const ligne = (deviceId: string) => prisma.notifDeviceState.findUnique({ where: { deviceId } });

describe.skipIf(SANS_BASE)("SUR VRAIE BASE — le relevé des notifications", () => {
  beforeAll(async () => {
    prisma = await ouvrirBaseDeTest();
    ({ POST } = await import("./route"));
    actif = (await prisma.user.create({ data: { displayName: `${MARQUEUR} actif` } })).id;
    desactive = (
      await prisma.user.create({ data: { displayName: `${MARQUEUR} désactivé`, disabledAt: new Date() } })
    ).id;
  }, 60_000);

  afterAll(async () => {
    if (!actif) return;
    // Les relevés tombent avec leur membre (Cascade).
    await prisma.user.deleteMany({ where: { id: { in: [actif, desactive] } } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    h.session = { userId: actif };
    await prisma.notifDeviceState.deleteMany({ where: { userId: { in: [actif, desactive] } } });
  });

  it("un appareil qui change de compte change de propriétaire, sans doublon", async () => {
    await POST(req(releve(appareil(1))));
    h.session = { userId: desactive };
    await POST(req(releve(appareil(1), "granted")));
    expect(await prisma.notifDeviceState.count({ where: { deviceId: appareil(1) } })).toBe(1);
    expect(await ligne(appareil(1))).toMatchObject({ userId: desactive, permission: "granted" });
  });

  it("un relevé INCHANGÉ rafraîchit quand même la date", async () => {
    await POST(req(releve(appareil(2))));
    await vieillir(appareil(2), 10);
    await POST(req(releve(appareil(2))));
    const l = await ligne(appareil(2));
    expect(Date.now() - l!.updatedAt.getTime()).toBeLessThan(60_000);
  });

  it("la purge efface les appareils muets depuis la rétention, et garde les autres", async () => {
    await POST(req(releve(appareil(3))));
    await POST(req(releve(appareil(4))));
    await vieillir(appareil(3), NOTIF_STATE_RETENTION_DAYS + 1);
    await vieillir(appareil(4), NOTIF_STATE_RETENTION_DAYS - 1);

    await POST(req(releve(appareil(5))));

    expect(await ligne(appareil(3))).toBeNull();
    expect(await ligne(appareil(4))).not.toBeNull();
    expect(await ligne(appareil(5))).not.toBeNull();
  });

  it("le tableau de bord ne compte que les appareils récents de comptes actifs", async () => {
    await POST(req(releve(appareil(6)))); // actif, récent, refusé → compté
    await POST(req(releve(appareil(7)))); // actif, mais muet depuis 40 j → hors fenêtre
    await vieillir(appareil(7), 40);
    h.session = { userId: desactive };
    await POST(req(releve(appareil(8)))); // compte désactivé → hors mesure

    const { getDashboard } = await import("@/lib/dashboard");
    const { notifs } = await getDashboard();
    expect(notifs.devices).toBe(1);
    expect(notifs.byMember.denied).toBe(1);
    expect(notifs.deniedByPlatform).toEqual({ "android-app": 1 });
  });
});
