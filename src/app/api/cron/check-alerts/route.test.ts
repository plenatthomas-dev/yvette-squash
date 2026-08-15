import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// Régression de sécurité : ce cron avait sa PROPRE copie de la récupération du jeton ResaMania.
// Elle passait la chaîne CHIFFRÉE en Bearer (→ 401, alerte perdue en silence) et réécrivait le
// jeton rafraîchi EN CLAIR en base — ce qui, à la visite suivante du membre, faisait échouer
// `decrypt` dans resolveResaToken et SUPPRIMAIT sa session (déconnexion forcée).
// Ces tests verrouillent le contrat : le jeton vient de session.ts, et ce cron n'écrit jamais
// sur `Session`.

const h = vi.hoisted(() => ({
  authorized: true,
  alerts: [] as Array<Record<string, unknown>>,
  resa: null as null | { accessToken: string },
  getPlanning: vi.fn(),
  sessionUpdate: vi.fn(),
  sessionFindFirst: vi.fn(),
  // Renvoie le NOMBRE d'abonnements servis (le vrai `pushToUser` fait ça) : la route teste
  // `sent > 0`, et un booléen ici masquerait le cas « aucun push parti ».
  pushToUser: vi.fn(async () => 1),
  slotAlertUpdateMany: vi.fn(),
  slotAlertUpdate: vi.fn(),
  // Porte d'entrée du cron (lib/alerts-gate) : mockée pour que ces tests restent centrés sur
  // le contrat « jeton ResaMania », et pour pouvoir piloter le chemin d'économie de réveil.
  pending: true,
  slotAlertFindMany: vi.fn(async () => h.alerts),
  alertsChanged: vi.fn(),
  noteCronAlive: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    slotAlert: {
      findMany: h.slotAlertFindMany,
      updateMany: h.slotAlertUpdateMany,
      update: h.slotAlertUpdate,
    },
    session: { update: h.sessionUpdate, findFirst: h.sessionFindFirst },
  },
}));
vi.mock("@/lib/session", () => ({ getResaTokenForUser: vi.fn(async () => h.resa) }));
vi.mock("@/lib/resamania/client", () => ({ getPlanning: h.getPlanning }));
vi.mock("@/lib/push", () => ({ pushToUser: h.pushToUser, pushConfigured: () => true }));
vi.mock("@/lib/cron-auth", () => ({ cronAuthorized: () => h.authorized }));
vi.mock("@/lib/cron-run", () => ({ recordCronRun: vi.fn() }));
// Mock PARTIEL : on garde la vraie `alertHorizonISO` (et sa constante) et on ne remplace que
// ce qui touche au cache. Une réimplémentation « équivalente » du calcul de date ici
// reproduirait justement les deux pièges corrigés dans le module — fuseau ambiant et
// arithmétique en millisecondes — et le test d'horizon ne verrouillerait plus rien.
vi.mock("@/lib/alerts-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/alerts-gate")>()),
  alertsPending: vi.fn(async () => h.pending),
  alertsChanged: h.alertsChanged,
  noteCronAlive: h.noteCronAlive,
}));

import { GET } from "./route";

const req = () => ({} as NextRequest);
// Un créneau demain : l'alerte ne doit pas être écartée comme « déjà passée ».
const tomorrow = () => {
  const d = new Date(Date.now() + 24 * 3600_000);
  return d.toLocaleDateString("en-CA");
};

beforeEach(() => {
  vi.clearAllMocks();
  h.authorized = true;
  h.pending = true;
  h.resa = { accessToken: "jeton-en-clair-valide" };
  h.alerts = [{ id: "a1", userId: "u1", date: tomorrow(), hm: "18:00", active: true }];
  h.getPlanning.mockResolvedValue({ slots: [] });
  // `vi.clearAllMocks()` n'efface que les APPELS, pas les implémentations posées par
  // `mockResolvedValue` : sans ce re-stub, un test qui force `pushToUser` à 0 contaminerait
  // tous les suivants, qui échoueraient pour une raison sans rapport avec ce qu'ils testent.
  h.pushToUser.mockResolvedValue(1);
});

describe("GET /api/cron/check-alerts — jeton ResaMania", () => {
  it("interroge le planning avec le jeton DÉCHIFFRÉ fourni par session.ts", async () => {
    await GET(req());
    expect(h.getPlanning).toHaveBeenCalledTimes(1);
    // Le 2e argument est le Bearer : il doit être le jeton en clair, jamais une chaîne chiffrée.
    expect(h.getPlanning.mock.calls[0][1]).toBe("jeton-en-clair-valide");
  });

  it("n'écrit JAMAIS sur Session (plus de persistance de jeton ici)", async () => {
    await GET(req());
    expect(h.sessionUpdate).not.toHaveBeenCalled();
    expect(h.sessionFindFirst).not.toHaveBeenCalled();
  });

  it("passe simplement l'alerte si le membre n'a plus de session ResaMania exploitable", async () => {
    h.resa = null;
    const res = await GET(req());
    expect(h.getPlanning).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("notifie quand le créneau visé est redevenu réservable", async () => {
    h.getPlanning.mockResolvedValue({
      slots: [{ startsAt: `${tomorrow()}T18:00:00+02:00`, bookable: true }],
    });
    await GET(req());
    expect(h.pushToUser).toHaveBeenCalledTimes(1);
  });

  it("refuse un appel non autorisé", async () => {
    h.authorized = false;
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(h.getPlanning).not.toHaveBeenCalled();
  });
});

// Ce cron est appelé toutes les ~4 minutes par un cron externe (17 h-22 h), or Neon suspend son
// compute après 5 minutes d'inactivité : une seule requête ici suffisait à le maintenir éveillé
// toute la plage, soit ~6 h/jour ≈ 46 CU-hours/mois pour un quota gratuit de 100. Ces tests
// verrouillent l'économie.
describe("GET /api/cron/check-alerts — porte d'entrée sans réveil de Postgres", () => {
  it("ne touche PAS la base quand aucune alerte n'est en attente", async () => {
    h.pending = false;
    const res = await GET(req());
    expect(h.slotAlertFindMany).not.toHaveBeenCalled();
    expect(h.getPlanning).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: true });
  });

  it("remet la porte d'aplomb si le cache prétendait à tort qu'il restait des alertes", async () => {
    h.alerts = []; // la porte dit « oui », la base dit « non » : invalidation manquée
    await GET(req());
    expect(h.alertsChanged).toHaveBeenCalled();
  });

  it("referme la porte après avoir désactivé une alerte notifiée", async () => {
    h.getPlanning.mockResolvedValue({
      slots: [{ startsAt: `${tomorrow()}T18:00:00+02:00`, bookable: true }],
    });
    await GET(req());
    expect(h.slotAlertUpdate).toHaveBeenCalled();
    expect(h.alertsChanged).toHaveBeenCalled();
  });

  it("referme la porte même si le push n'est parti pour personne", async () => {
    // L'alerte est désactivée dans tous les cas : c'est la DÉSACTIVATION qui doit refermer la
    // porte, pas l'envoi réussi. Compter les push laisserait le cron réveiller Postgres en
    // boucle jusqu'au TTL alors qu'il n'y a plus rien à surveiller.
    h.pushToUser.mockResolvedValue(0);
    h.getPlanning.mockResolvedValue({
      slots: [{ startsAt: `${tomorrow()}T18:00:00+02:00`, bookable: true }],
    });
    await GET(req());
    expect(h.alertsChanged).toHaveBeenCalled();
  });

  it("laisse la porte fermée quand il n'y a rien à désactiver", async () => {
    // Alerte bien active mais créneau toujours pris : rien ne change, donc aucune invalidation
    // (chaque invalidation coûte un réveil de Postgres au passage suivant).
    await GET(req());
    expect(h.alertsChanged).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/check-alerts — horizon des alertes", () => {
  it("désactive sans notifier une alerte au-delà de l'horizon réservable", async () => {
    // Une date lointaine (faute de frappe « 2027 », ou requête forgée) ne se déclencherait
    // jamais mais tiendrait la porte du cron ouverte pour toujours — le compute Neon ne se
    // rendormirait plus, soit exactement le problème que ce lot supprime.
    const loin = new Date(Date.now() + 400 * 24 * 3600_000).toLocaleDateString("en-CA");
    h.alerts = [{ id: "a9", userId: "u1", date: loin, hm: "18:00", active: true }];
    const res = await GET(req());
    expect(h.slotAlertUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { active: false } }),
    );
    expect(h.pushToUser).not.toHaveBeenCalled();
    expect(h.getPlanning).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ expired: 1, notified: 0 });
    expect(h.alertsChanged).toHaveBeenCalled(); // la porte doit se refermer
  });
});
