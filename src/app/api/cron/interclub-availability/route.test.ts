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

  it("ne relance PAS un membre injoignable — la notification n'irait nulle part", async () => {
    h.fixtures = [ouverte()];
    h.members = [membre("u1", "Alice", true), membre("u2", "Bob", false)];
    await GET(req());
    expect(h.reminders[0][0]).toEqual(["u1"]);
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
