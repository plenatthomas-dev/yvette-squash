import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { NextRequest } from "next/server";
import type { PushPayload } from "@/lib/push";
import { CLUB_TZ, toInstant } from "@/lib/time";

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
  // Jeton PAR MEMBRE quand un test en a besoin (panne pour l'un, jeton frais pour l'autre) ;
  // sinon `resa` vaut pour tout le monde.
  tokenFor: null as null | ((userId: string) => Promise<unknown>),
  getPlanning: vi.fn(),
  login: vi.fn(),
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
vi.mock("@/lib/session", () => ({
  getResaTokenForUser: vi.fn((userId: string) =>
    h.tokenFor ? h.tokenFor(userId) : Promise.resolve(h.resa),
  ),
}));
vi.mock("@/lib/resamania/client", () => ({ getPlanning: h.getPlanning, login: h.login }));
vi.mock("@/lib/push", () => ({ pushToUser: h.pushToUser, pushConfigured: () => true }));
vi.mock("@/lib/cron-auth", () => ({ cronAuthorized: () => h.authorized }));
vi.mock("@/lib/cron-run", () => ({
  recordCronRun: vi.fn(),
  runCron: (_n: string, fn: () => Promise<unknown>) => fn(),
}));
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
import { recordCronRun } from "@/lib/cron-run";
import { ResaRefreshTransientError } from "@/lib/resamania/errors";

const req = () => ({} as NextRequest);
// Un créneau demain : l'alerte ne doit pas être écartée comme « déjà passée ». Date du CLUB,
// pas celle du process : le fuseau de la machine de test ne doit rien décider.
const tomorrow = () => {
  const d = new Date(Date.now() + 24 * 3600_000);
  return d.toLocaleDateString("en-CA", { timeZone: CLUB_TZ });
};
// 18 h DU CLUB demain, en instant absolu. Ces créneaux étaient écrits avec un décalage en dur,
// `…T18:00:00+02:00` : juste l'été seulement. La route compare `fmtTime(startsAt)` — heure de
// Paris — au `hm` de l'alerte ; dès que « demain » tombait en heure d'hiver, +02:00 donnait
// 17:00 à Paris, le créneau ne correspondait plus et quatre tests échouaient sans que la route
// ait changé (bombe à retardement du samedi 24/10/2026). `toInstant` applique le bon décalage
// quelle que soit la saison — cf. le bloc « heure d'hiver » en fin de fichier.
const at18 = () => toInstant(`${tomorrow()}T18:00:00`);

beforeEach(() => {
  vi.clearAllMocks();
  h.authorized = true;
  h.pending = true;
  h.resa = { accessToken: "jeton-en-clair-valide" };
  h.tokenFor = null;
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
      slots: [{ startsAt: at18(), bookable: true }],
    });
    await GET(req());
    expect(h.pushToUser).toHaveBeenCalledTimes(1);
  });

  it("joint le bouton « Réserver » et TOUS les terrains libres à cet horaire", async () => {
    const at = at18();
    h.getPlanning.mockResolvedValue({
      slots: [
        { id: "/c/class_events/1", courtName: "Terrain 1", startsAt: at, bookable: true },
        { id: "/c/class_events/2", courtName: "Terrain 2", startsAt: at, bookable: false },
        { id: "/c/class_events/3", courtName: "Terrain 3", startsAt: at, bookable: true },
        // Libre, mais à une autre heure : ce n'est pas ce que l'alerte attend.
        { id: "/c/class_events/4", courtName: "Terrain 1", startsAt: toInstant(`${tomorrow()}T18:40:00`), bookable: true },
      ],
    });
    await GET(req());
    const [, payload] = h.pushToUser.mock.calls[0] as unknown as [string, PushPayload];
    expect(payload.actions).toEqual([{ action: "book", title: "Réserver" }]);
    expect(payload.data?.book).toEqual({
      quand: expect.stringContaining("à 18:00"),
      startsAt: at,
      courts: [
        { id: "/c/class_events/1", name: "Terrain 1" },
        { id: "/c/class_events/3", name: "Terrain 3" },
      ],
    });
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
      slots: [{ startsAt: at18(), bookable: true }],
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
      slots: [{ startsAt: at18(), bookable: true }],
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

// Les créneaux bouchonnés sont construits en heure du club (`at18`). Ce bloc le PROUVE en
// figeant l'horloge des deux côtés du changement d'heure : avec l'ancien `+02:00` en dur, le
// cas d'hiver échouait (le créneau tombait à 17:00 à Paris et ne matchait plus l'alerte 18:00).
describe.each([
  ["été", "2026-07-15T08:00:00Z"],
  ["hiver", "2026-11-15T08:00:00Z"],
])("GET /api/cron/check-alerts — %s", (_saison, instant) => {
  beforeEach(() => {
    // Seule `Date` est simulée : les promesses et les microtâches tournent normalement.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(instant));
    h.alerts = [{ id: "a1", userId: "u1", date: tomorrow(), hm: "18:00", active: true }];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("notifie quand le créneau de 18 h du club est redevenu réservable", async () => {
    h.getPlanning.mockResolvedValue({ slots: [{ startsAt: at18(), bookable: true }] });
    await GET(req());
    expect(h.pushToUser).toHaveBeenCalledTimes(1);
    expect(h.slotAlertUpdate).toHaveBeenCalled();
    expect(h.alertsChanged).toHaveBeenCalled();
  });
});

// Une alerte ILLISIBLE en base — horaire « 12:75 », jour « 2026-10-32 », écrits quand
// POST /api/alerts ne contrôlait que la forme. `toInstant` lève sur ces valeurs, et le
// classement était hors de tout `try` : le cron tombait à CHAQUE passage, pour tout le club, et
// la ligne fautive n'était jamais désactivée.
describe("GET /api/cron/check-alerts — alerte illisible en base", () => {
  it.each([
    { date: "TOMORROW", hm: "12:75" },
    { date: "TOMORROW", hm: "99:99" },
    { date: "2026-10-32", hm: "18:00" },
  ])("ne plante pas et expire l'alerte %j", async ({ date, hm }) => {
    h.alerts = [
      { id: "bad", userId: "u1", date: date === "TOMORROW" ? tomorrow() : date, hm, active: true },
    ];
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ expired: 1, notified: 0 });
    expect(h.slotAlertUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["bad"] } },
      data: { active: false },
    });
    expect(h.pushToUser).not.toHaveBeenCalled();
    expect(h.alertsChanged).toHaveBeenCalled();
  });

  it("traite normalement les alertes saines voisines", async () => {
    h.alerts = [
      { id: "bad", userId: "u1", date: tomorrow(), hm: "12:75", active: true },
      { id: "ok", userId: "u2", date: tomorrow(), hm: "18:00", active: true },
    ];
    h.getPlanning.mockResolvedValue({ slots: [{ startsAt: at18(), bookable: true }] });
    const res = await GET(req());
    expect(await res.json()).toMatchObject({ expired: 1, notified: 1 });
    expect(h.pushToUser).toHaveBeenCalledWith("u2", expect.anything());
  });
});

// Sans consigne, web-push garde une notification QUATRE SEMAINES pour un téléphone éteint, en
// urgence normale (Android en veille la diffère). Pour « un terrain s'est libéré », elle n'a plus
// d'objet une fois le créneau commencé, et chaque seconde compte.
describe("GET /api/cron/check-alerts — durée de vie et urgence du push", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const pousse = async () => {
    h.getPlanning.mockResolvedValue({ slots: [{ startsAt: at18(), bookable: true }] });
    await GET(req());
    const [, payload] = h.pushToUser.mock.calls[0] as unknown as [string, PushPayload];
    return payload;
  };

  it("urgence haute, TTL plafonné à une heure pour un créneau lointain", async () => {
    const payload = await pousse();
    expect(payload.urgency).toBe("high");
    expect(payload.ttl).toBe(3600);
  });

  it("TTL = secondes restantes avant le début du créneau", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // Jour figé AVANT de déplacer l'horloge : `tomorrow()` relu ensuite viserait le surlendemain.
    const jour = tomorrow();
    const debut = new Date(toInstant(`${jour}T18:00:00`)).getTime();
    vi.setSystemTime(debut - 10 * 60_000); // 17 h 50 du club
    h.alerts = [{ id: "a1", userId: "u1", date: jour, hm: "18:00", active: true }];
    h.getPlanning.mockResolvedValue({
      slots: [{ startsAt: new Date(debut).toISOString(), bookable: true }],
    });
    await GET(req());
    const [, payload] = h.pushToUser.mock.calls[0] as unknown as [string, PushPayload];
    expect(payload.ttl).toBe(600);
  });

  it("plancher d'une minute quand le créneau commence dans quelques secondes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const jour = tomorrow();
    const debut = new Date(toInstant(`${jour}T18:00:00`)).getTime();
    vi.setSystemTime(debut - 20_000);
    h.alerts = [{ id: "a1", userId: "u1", date: jour, hm: "18:00", active: true }];
    h.getPlanning.mockResolvedValue({
      slots: [{ startsAt: new Date(debut).toISOString(), bookable: true }],
    });
    await GET(req());
    const [, payload] = h.pushToUser.mock.calls[0] as unknown as [string, PushPayload];
    expect(payload.ttl).toBe(60);
  });
});

// RÉGRESSION de f44b690 : `getResaTokenForUser` LÈVE sur une panne passagère de ResaMania (au
// lieu de supprimer la session et rendre null). Hors de tout try, la première exception
// interrompait la passe entière : plus aucune alerte vérifiée, pour personne, tant que la
// panne durait — et le heartbeat ne disait rien.
describe("GET /api/cron/check-alerts — jeton en panne passagère", () => {
  it("saute ce membre, vérifie les SUIVANTS, ne désactive pas son alerte, compte « reportée »", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    h.alerts = [
      { id: "a1", userId: "u-panne", date: tomorrow(), hm: "18:00", active: true },
      { id: "a2", userId: "u-ok", date: tomorrow(), hm: "18:00", active: true },
    ];
    h.tokenFor = (userId) =>
      userId === "u-panne"
        ? Promise.reject(new ResaRefreshTransientError("ResaMania momentanément indisponible"))
        : Promise.resolve({ accessToken: "jeton-ok" });
    h.getPlanning.mockResolvedValue({ slots: [{ startsAt: at18(), bookable: true }] });

    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ checked: 2, notified: 1, reportes: 1 });
    // Le membre suivant a bien été servi…
    expect(h.pushToUser).toHaveBeenCalledTimes(1);
    expect(h.pushToUser).toHaveBeenCalledWith("u-ok", expect.anything());
    // …et l'alerte du membre en panne reste ACTIVE : seule a2 a été désactivée.
    expect(h.slotAlertUpdate).toHaveBeenCalledTimes(1);
    expect(h.slotAlertUpdate.mock.calls[0][0]).toMatchObject({ where: { id: "a2" } });
    // Le heartbeat le dit.
    expect(vi.mocked(recordCronRun)).toHaveBeenCalledWith(
      "check-alerts",
      true,
      expect.stringContaining("1 reportée(s)"),
    );
  });

  it("une erreur NON passagère sur un membre ne prive pas non plus les autres de leur vérification", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.alerts = [
      { id: "a1", userId: "u-casse", date: tomorrow(), hm: "18:00", active: true },
      { id: "a2", userId: "u-ok", date: tomorrow(), hm: "18:00", active: true },
    ];
    h.tokenFor = (userId) =>
      userId === "u-casse"
        ? Promise.reject(new Error("Can't reach database server"))
        : Promise.resolve({ accessToken: "jeton-ok" });
    h.getPlanning.mockResolvedValue({ slots: [{ startsAt: at18(), bookable: true }] });

    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(h.pushToUser).toHaveBeenCalledTimes(1);
    expect(await res.json()).toMatchObject({ reportes: 1 });
  });

  it("aucun report : `reportes: 0` et heartbeat inchangé", async () => {
    await GET(req());
    expect(vi.mocked(recordCronRun)).toHaveBeenCalledWith(
      "check-alerts",
      true,
      expect.not.stringContaining("reportée"),
    );
  });
});

// Audit 2026-10, point 8 : la liste d'attente d'un compte « email seul » (sans jeton ResaMania)
// ne se déclenchait jamais. Le planning se lit désormais avec le compte de service.
describe("GET /api/cron/check-alerts — compte de service", () => {
  beforeEach(async () => {
    vi.stubEnv("RESA_CRON_USER", "service");
    vi.stubEnv("RESA_CRON_PASSWORD", "secret");
    const { resetServiceTokenMemo } = await import("@/lib/resamania/service");
    resetServiceTokenMemo();
    h.login.mockReset().mockResolvedValue({ accessToken: "jeton-service", expiresAt: Date.now() + 3_600_000 });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("notifie un membre SANS jeton ResaMania, planning lu avec le compte de service", async () => {
    h.resa = null;
    h.getPlanning.mockResolvedValue({ slots: [{ startsAt: at18(), bookable: true }] });
    await GET(req());
    expect(h.getPlanning).toHaveBeenCalledWith(expect.any(String), "jeton-service");
    expect(h.pushToUser).toHaveBeenCalledWith("u1", expect.anything());
  });

  it("UNE lecture par jour surveillé, quel que soit le nombre de membres", async () => {
    h.alerts = [
      { id: "a1", userId: "u1", date: tomorrow(), hm: "18:00", active: true },
      { id: "a2", userId: "u2", date: tomorrow(), hm: "18:00", active: true },
    ];
    await GET(req());
    expect(h.getPlanning).toHaveBeenCalledTimes(1);
  });

  it("compte de service en échec de lecture → retombe sur le jeton du membre", async () => {
    h.getPlanning.mockImplementation(async (_d: string, tok: string) => {
      if (tok === "jeton-service") throw new Error("boum");
      return { slots: [{ startsAt: at18(), bookable: true }] };
    });
    await GET(req());
    expect(h.getPlanning).toHaveBeenLastCalledWith(expect.any(String), "jeton-en-clair-valide");
    expect(h.pushToUser).toHaveBeenCalledTimes(1);
  });
});
