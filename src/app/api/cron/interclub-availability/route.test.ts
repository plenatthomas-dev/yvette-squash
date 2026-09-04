import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// L'APPEL DE DISPONIBILITÉ ET SA RELANCE.
//
// Trois garanties qu'aucune relecture ne donne, et dont chacune a un coût réel si elle tombe :
//
//  1. RIEN sur une date non confirmée. La fédération publie les journées non planifiées avec
//     une date bouchon commune (J10 à J14 toutes au même jour, mesuré sur l'événement réel) :
//     convoquer l'équipe là-dessus l'enverrait cinq fois le même soir et lui apprendrait à
//     ignorer ces notifications.
//  2. Une seule fois. Le cron passe tous les jours ; sans les marqueurs, il redemanderait
//     chaque matin à la même équipe si elle est disponible.
//  3. La relance ne va QU'aux non-répondants joignables. Relancer ceux qui ont déjà répondu
//     punit exactement ceux qu'on veut garder ; relancer un injoignable ne produit rien et
//     laisse croire que le travail est fait.

const h = vi.hoisted(() => ({
  interclub: true,
  authorized: true,
  fixtures: [] as Array<Record<string, unknown>>,
  members: [] as Array<Record<string, unknown>>,
  guests: [] as Array<Record<string, unknown>>,
  answers: [] as Array<Record<string, unknown>>,
  /** Ce que chaque `interclub.update` a écrit : les marqueurs d'idempotence. */
  updates: [] as Array<Record<string, unknown>>,
  calls: [] as unknown[][],
  reminders: [] as unknown[][],
  digests: [] as unknown[][],
}));

vi.mock("@/lib/features-server", () => ({ getFeatures: async () => ({ interclub: h.interclub }) }));
vi.mock("@/lib/cron-auth", () => ({ cronAuthorized: () => h.authorized }));
vi.mock("@/lib/cron-run", () => ({ recordCronRun: vi.fn() }));
// Importé pour être INSPECTÉ : ce cron l'appelait deux fois, et `recordCronRun` étant un upsert
// d'une seule ligne par cron, le second appel effaçait le premier.
// Aujourd'hui est FIGÉ : un test qui dépend de la date du jour passe en octobre et échoue en
// novembre, et on croit alors à une régression.
vi.mock("@/lib/interclub-gate", () => ({ todayISO: () => "2026-10-01" }));
vi.mock("@/lib/interclub-notify", () => ({
  notifyAvailabilityCall: vi.fn(async (...a: unknown[]) => {
    h.calls.push(a);
  }),
  notifyAvailabilityReminder: vi.fn(async (...a: unknown[]) => {
    h.reminders.push(a);
  }),
  notifyCaptainDigest: vi.fn(async (...a: unknown[]) => {
    h.digests.push(a);
  }),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    interclub: {
      findMany: vi.fn(async () => h.fixtures),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        h.updates.push(args.data);
        return {};
      }),
    },
    user: { findMany: vi.fn(async () => h.members) },
    interclubGuest: { findMany: vi.fn(async () => h.guests) },
    interclubAvailability: { findMany: vi.fn(async () => h.answers) },
  },
}));

import { GET } from "./route";
import { recordCronRun } from "@/lib/cron-run";

const req = () => ({ headers: new Headers() }) as unknown as NextRequest;

/** Une rencontre à venir, confirmée, appel non encore ouvert. */
const fixture = (over: Record<string, unknown> = {}) => ({
  id: "f1",
  date: "2026-10-08", // J-7
  time: "20:00",
  home: true,
  teamId: "t1",
  matchCount: 4,
  dateConfirmed: true,
  availabilityOpenedAt: null,
  availabilityRemindedAt: null,
  opponent: "Montmartre 1",
  team: { name: "Équipe 1", captainId: "cap" },
  ...over,
});

const membre = (id: string, name: string, joignable = true) => ({
  id,
  displayName: name,
  nickname: null,
  pushSubs: joignable ? [{ id: "s" }] : [],
});

beforeEach(() => {
  vi.mocked(recordCronRun).mockClear();
  h.interclub = true;
  h.authorized = true;
  h.fixtures = [];
  h.members = [membre("u1", "Alice"), membre("u2", "Bob")];
  h.guests = [];
  h.answers = [];
  h.updates = [];
  h.calls = [];
  h.reminders = [];
  h.digests = [];
});

describe("gardes", () => {
  it("404 quand l'interclub est coupé", async () => {
    h.interclub = false;
    expect((await GET(req())).status).toBe(404);
  });

  it("401 sans le secret du cron", async () => {
    h.authorized = false;
    expect((await GET(req())).status).toBe(401);
  });
});

describe("ouverture de l'appel (J-10)", () => {
  it("ouvre l'appel et pose le marqueur", async () => {
    h.fixtures = [fixture()];
    const body = await (await GET(req())).json();
    expect(body.called).toBe(1);
    expect(h.calls).toHaveLength(1);
    expect(h.updates[0]).toHaveProperty("availabilityOpenedAt");
  });

  it("n'ouvre PAS deux fois", async () => {
    h.fixtures = [fixture({ availabilityOpenedAt: new Date("2026-09-28") })];
    const body = await (await GET(req())).json();
    expect(body.called).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it("attend d'être dans la fenêtre", async () => {
    // Ouvrir un mois avant ne récolterait que des « incertain ».
    h.fixtures = [fixture({ date: "2026-12-10" })];
    expect((await (await GET(req())).json()).called).toBe(0);
  });

  it("SE TAIT sur une date non confirmée", async () => {
    // Le cas mesuré sur le vrai calendrier : cinq journées à la même date bouchon.
    h.fixtures = [fixture({ dateConfirmed: false })];
    const body = await (await GET(req())).json();
    expect(body.called).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.updates).toEqual([]);
  });

  it("ne réveille personne sur une rencontre passée", async () => {
    h.fixtures = [fixture({ date: "2026-09-24" })];
    expect((await (await GET(req())).json()).called).toBe(0);
  });
});

describe("relance (J-3) et récapitulatif du capitaine", () => {
  const ouverte = (over: Record<string, unknown> = {}) =>
    fixture({ date: "2026-10-03", availabilityOpenedAt: new Date("2026-09-25"), ...over });

  it("relance les SEULS non-répondants", async () => {
    h.fixtures = [ouverte()];
    h.answers = [{ userId: "u1", guestId: null, status: "yes" }];
    await GET(req());
    // Alice a répondu : la relancer punirait exactement celle qu'on veut garder.
    expect(h.reminders[0][0]).toEqual(["u2"]);
  });

  it("relance AUSSI un membre injoignable : la cloche est le repli du push", async () => {
    // Le contraire semblait économe — à quoi bon pousser vers un appareil qui ne reçoit rien ?
    // Mais dans ce projet le journal est alimenté depuis le TRANSPORT, pour tous les
    // destinataires visés : écarter Bob le privait aussi de la ligne qu'il aurait lue en
    // ouvrant l'appli, c'est-à-dire du seul canal qui lui restait. Il demeure par ailleurs
    // dans la liste d'appels du capitaine — une entrée dans la cloche n'est pas une preuve
    // qu'on l'a vue.
    h.fixtures = [ouverte()];
    h.members = [membre("u1", "Alice", true), membre("u2", "Bob", false)];
    await GET(req());
    expect(h.reminders[0][0]).toEqual(["u1", "u2"]);
  });

  it("laisse malgré tout l'injoignable dans la liste d'APPELS du capitaine", async () => {
    h.fixtures = [ouverte()];
    h.members = [membre("u1", "Alice", true), membre("u2", "Bob", false)];
    await GET(req());
    // 5e argument de notifyCaptainDigest : les noms de ceux qu'aucune notification n'atteint.
    expect(h.digests[0][4]).toContain("Bob");
  });

  it("n'envoie aucune relance quand tout le monde a répondu", async () => {
    h.fixtures = [ouverte()];
    h.answers = [
      { userId: "u1", guestId: null, status: "yes" },
      { userId: "u2", guestId: null, status: "no" },
    ];
    await GET(req());
    expect(h.reminders).toEqual([]);
  });

  it("envoie au CAPITAINE, et à lui seul, le récap avec la liste à appeler", async () => {
    // Sans cette liste, il relance en aveugle des gens qui ne verront rien.
    h.fixtures = [ouverte()];
    h.members = [membre("u1", "Alice", true), membre("u2", "Bob", false)];
    h.guests = [{ id: "g1", name: "Paul Hors-Appli" }];
    h.answers = [{ userId: "u1", guestId: null, status: "yes" }];
    await GET(req());
    expect(h.digests).toHaveLength(1);
    expect(h.digests[0][0]).toBe("cap");
    expect(h.digests[0][3]).toMatchObject({ yes: 1, maybe: 0, no: 0 });
    expect(h.digests[0][4]).toEqual(["Bob", "Paul Hors-Appli"]);
  });

  it("se passe de récap quand l'équipe n'a pas de capitaine", async () => {
    h.fixtures = [ouverte({ team: { name: "Équipe 1", captainId: null } })];
    await GET(req());
    expect(h.digests).toEqual([]);
    // La relance, elle, part quand même : elle ne dépend de personne.
    expect(h.reminders).toHaveLength(1);
  });

  it("ne relance QU'UNE FOIS", async () => {
    h.fixtures = [ouverte({ availabilityRemindedAt: new Date("2026-09-30") })];
    const body = await (await GET(req())).json();
    expect(body.reminded).toBe(0);
    expect(h.reminders).toEqual([]);
    expect(h.digests).toEqual([]);
  });

  it("pose le marqueur de relance même si personne n'était à relancer", async () => {
    // Sinon le récap du capitaine repartirait chaque matin jusqu'à la rencontre.
    h.fixtures = [ouverte()];
    h.answers = [
      { userId: "u1", guestId: null, status: "yes" },
      { userId: "u2", guestId: null, status: "yes" },
    ];
    await GET(req());
    expect(h.updates.at(-1)).toHaveProperty("availabilityRemindedAt");
  });

  it("n'écrit QU'UN heartbeat, et il porte le sous-effectif", async () => {
    // `recordCronRun` est un upsert d'UNE ligne par cron. Ce cron l'appelait dans la boucle pour
    // signaler « il manque du monde », puis une dernière fois en sortie : le dernier écrit
    // gagnait, et le tableau de bord n'a jamais montré autre chose que le décompte des envois.
    // Le message qui compte pour un capitaine était écrit puis effacé dans la même requête.
    h.fixtures = [ouverte()];
    h.answers = [{ userId: "u1", guestId: null, status: "yes" }];
    await GET(req());

    const appels = vi.mocked(recordCronRun).mock.calls;
    expect(appels).toHaveLength(1);
    expect(String(appels[0][2])).toMatch(/sous-effectif/i);
    expect(String(appels[0][2])).toMatch(/1\/4/);
  });

  it("un « incertain » compte comme une réponse, mais pas comme un présent", async () => {
    // Il ne doit donc PAS être relancé, et ne doit PAS remplir la feuille du capitaine.
    h.fixtures = [ouverte()];
    h.answers = [
      { userId: "u1", guestId: null, status: "maybe" },
      { userId: "u2", guestId: null, status: "maybe" },
    ];
    await GET(req());
    expect(h.reminders).toEqual([]);
    expect(h.digests[0][3]).toMatchObject({ yes: 0, maybe: 2 });
  });
});
