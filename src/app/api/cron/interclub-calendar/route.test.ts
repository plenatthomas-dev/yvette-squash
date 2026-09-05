import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";

// LE CONTRÔLE HEBDOMADAIRE DU CALENDRIER FÉDÉRAL.
//
// Ce cron PRÉVIENT, il n'applique pas. Appliquer un écart efface les disponibilités des
// rencontres déplacées et re-notifie l'équipe : un scraping qui casse — squashnet a déjà changé
// son rendu HTML du jour au lendemain, en silence — pourrait alors vider un calendrier ou
// déplacer une convocation sans que personne ne l'ait voulu.
//
// Trois choses à tenir, et aucune ne se voit à la relecture :
//   * il n'écrit AUCUNE rencontre ;
//   * il alerte UNE FOIS pour un même écart (sinon le même report reviendrait tous les lundis
//     jusqu'à ce qu'un admin l'applique, et l'alerte deviendrait un bruit qu'on n'ouvre plus) ;
//   * un hoquet réseau n'est pas un calendrier vide.

const h = vi.hoisted(() => ({
  interclub: true,
  authorized: true,
  teams: [] as Array<Record<string, unknown>>,
  stored: [] as Array<Record<string, unknown>>,
  /** Ce que squashnet rend, ou l'erreur qu'il jette. */
  published: [] as Array<import("@/lib/squashnet/calendar").OwnTie>,
  fetchThrows: false,
  /** Le calendrier a été REÇU mais ne se lit plus — distinct du hoquet réseau. */
  fetchUnreadable: false,
  unreadable: [] as unknown[][],
  teamUpdates: [] as Array<Record<string, unknown>>,
  drifts: [] as unknown[][],
  admins: [] as Array<{ id: string; email: string }>,
  standings: [] as Array<Record<string, unknown>>,
  standingsThrows: false,
}));

vi.mock("@/lib/features-server", () => ({ getFeatures: async () => ({ interclub: h.interclub }) }));
vi.mock("@/lib/cron-auth", () => ({ cronAuthorized: () => h.authorized }));
vi.mock("@/lib/cron-run", () => ({ recordCronRun: vi.fn() }));
// « Qui est admin » se lit désormais EN BASE, en une requête et hors boucle : le cron chargeait
// tous les emails du club, une fois par équipe, pour n'en retenir que deux ou trois.
vi.mock("@/lib/admin", () => ({
  adminUserIds: async () => h.admins.map((a) => a.id),
}));
// Le parsing est éprouvé chez lui (`squashnet/calendar.test.ts`, sur fragment réel) : ici on
// mocke le RÉSEAU seulement, et on garde le vrai `diffCalendar` / `calendarFingerprint`.
vi.mock("@/lib/squashnet/calendar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/squashnet/calendar")>()),
  fetchTeamCalendar: vi.fn(async (...args: unknown[]) => {
    if (h.fetchThrows) throw new Error("502");
    if (h.fetchUnreadable) {
      const { CalendarUnreadableError } =
        await importOriginal<typeof import("@/lib/squashnet/calendar")>();
      throw new CalendarUnreadableError("le rendu a changé");
    }
    void args;
    return [];
  }),
  // `ownFixtures` reçoit le tableau vide ci-dessus : on lui substitue ce que le test veut voir
  // publié, ce qui évite de reconstruire un fragment HTML dans chaque cas.
  ownFixtures: vi.fn(() => h.published),
}));
vi.mock("@/lib/interclub-notify", () => ({
  notifyCalendarDrift: vi.fn(async (...a: unknown[]) => {
    h.drifts.push(a);
  }),
  notifyCalendarUnreadable: vi.fn(async (...a: unknown[]) => {
    h.unreadable.push(a);
  }),
}));
vi.mock("@/lib/squashnet/standings", () => ({
  fetchStandings: vi.fn(async () => {
    if (h.standingsThrows) throw new Error("502");
    return h.standings;
  }),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    interclubTeam: {
      findMany: vi.fn(async () => h.teams),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        h.teamUpdates.push(args.data);
        return {};
      }),
    },
    interclub: { findMany: vi.fn(async () => h.stored) },
    user: { findMany: vi.fn(async () => h.admins) },
  },
}));

import { GET } from "./route";
import { calendarFingerprint, matchKey, type OwnTie } from "@/lib/squashnet/calendar";

const req = () => ({ headers: new Headers() }) as unknown as NextRequest;

/**
 * Les écritures d'équipe qui relèvent du CALENDRIER, à l'exclusion du classement.
 *
 * Le cron en produit deux sortes depuis qu'il rafraîchit aussi le classement de la poule.
 * Les distinguer par leur contenu et non par leur rang évite qu'un ajout ultérieur dans la
 * boucle ne fasse échouer des assertions qui ne le concernent pas.
 */
const majCalendrier = () => h.teamUpdates.filter((u) => !("snStandingsJson" in u));
const EVENT = "ev1";

const tie = (over: Partial<OwnTie> = {}): OwnTie => ({
  round: "J1",
  date: "2026-10-09",
  time: "20:00",
  home: true,
  opponent: "Montmartre 1",
  venue: "SQUASH DE L YVETTE",
  venueAddress: "1 rue du squash",
  dateConfirmed: true,
  ...over,
});

const team = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  name: "Équipe 1",
  snEventId: EVENT,
  snTeamId: "161092",
  snRoundId: "370138",
  snDrawId: "47760",
  snCalendarHash: calendarFingerprint([tie()]),
  captainId: "cap",
  ...over,
});

/** La rencontre correspondante en base, issue de l'import. */
const stored = (over: Record<string, unknown> = {}) => ({
  id: "f1",
  round: "J1",
  date: "2026-10-09",
  time: "20:00",
  home: true,
  opponent: "Montmartre 1",
  venue: "SQUASH DE L YVETTE",
  venueAddress: "1 rue du squash",
  dateConfirmed: true,
  snMatchKey: matchKey(EVENT, "J1"),
  ...over,
});

beforeEach(() => {
  h.interclub = true;
  h.authorized = true;
  h.teams = [team()];
  h.stored = [stored()];
  h.published = [tie()];
  h.fetchThrows = false;
  h.fetchUnreadable = false;
  h.unreadable = [];
  h.teamUpdates = [];
  h.drifts = [];
  h.admins = [{ id: "adm", email: "chef@ex.com" }];
  h.standings = [{ rank: 2, name: "Squash de l'Yvette", snTeamId: "161092", points: 9 }];
  h.standingsThrows = false;
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

describe("contrôle de dérive", () => {
  it("se tait quand rien n'a bougé, mais note qu'il a regardé", async () => {
    // `snCheckedAt` répond à la question que le silence ne tranche pas : « rien n'a bougé »,
    // ou « on n'a pas regardé » ?
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ checked: 1, drifted: 0, failed: 0 });
    expect(h.drifts).toEqual([]);
    expect(majCalendrier()[0]).toHaveProperty("snCheckedAt");
  });

  it("alerte quand une journée est DÉPLACÉE, en disant laquelle et vers quand", async () => {
    h.published = [tie({ date: "2026-10-16" })];
    const body = await (await GET(req())).json();
    expect(body.drifted).toBe(1);
    // L'ÉQUIPE ENTIÈRE, et non son seul nom : le tag de la notification est bâti sur son
    // identifiant, comme tous les autres tags du module. Sur le nom, un renommage faisait
    // cohabiter deux alertes pour la même équipe.
    expect(h.drifts[0][1]).toMatchObject({ id: "t1", name: "Équipe 1" });
    expect(h.drifts[0][2]).toEqual(["J1 déplacée au 2026-10-16"]);
  });

  it("prévient le capitaine ET les admins", async () => {
    h.published = [tie({ date: "2026-10-16" })];
    await GET(req());
    expect(h.drifts[0][0]).toEqual(expect.arrayContaining(["adm", "cap"]));
  });

  it("N'ÉCRIT AUCUNE RENCONTRE — c'est tout l'intérêt d'alerter plutôt qu'appliquer", async () => {
    h.published = [tie({ date: "2026-10-16" }), tie({ round: "J2", date: "2026-10-23" })];
    await GET(req());
    // Seule la table des équipes est touchée (l'horodatage du contrôle).
    expect(majCalendrier().every((u) => "snCheckedAt" in u)).toBe(true);
  });

  it("ne met PAS à jour l'empreinte quand elle a bougé", async () => {
    // La mettre à jour ici ferait taire le lundi suivant un écart que personne n'a appliqué.
    h.published = [tie({ date: "2026-10-16" })];
    await GET(req());
    expect(h.teamUpdates.some((u) => "snCalendarHash" in u)).toBe(false);
  });

  it("premier passage : n'enregistre PAS l'empreinte, et signale ce qu'il y a à importer", async () => {
    // `snCalendarHash` est remis à null par chaque (ré)ancrage d'équipe. En l'écrivant ici, le
    // cron avalait l'écart initial POUR TOUJOURS : on ancrait le dimanche en remettant l'import
    // au lendemain, le cron passait le lundi, n'alertait pas, et les lundis suivants trouvaient
    // l'empreinte égale. Les rencontres n'entraient jamais en base et aucun appel de
    // disponibilité ne s'ouvrait.
    h.teams = [team({ snCalendarHash: null })];
    h.stored = [];
    await GET(req());
    expect(majCalendrier().some((u) => "snCalendarHash" in u)).toBe(false);
    expect(h.drifts[0][2]).toEqual(["J1 nouvelle (2026-10-09)"]);
  });

  it("premier passage : dit « à importer » et non « a changé »", async () => {
    // Rien n'a changé sur une équipe qu'on regarde pour la première fois : tout est à prendre.
    // Le mot compte, il donne le ton de toutes les alertes suivantes.
    h.teams = [team({ snCalendarHash: null })];
    h.stored = [];
    await GET(req());
    expect(h.drifts[0][3]).toBe(true);
  });

  it("premier passage sur une base DÉJÀ à jour : rien à dire", async () => {
    // Le cas que l'ancienne écriture d'empreinte voulait couvrir, et qui se traite tout seul :
    // s'il n'y a aucun écart, il n'y a aucune alerte, empreinte ou pas.
    h.teams = [team({ snCalendarHash: null })];
    await GET(req());
    expect(h.drifts).toEqual([]);
  });

  it("annonce une journée NOUVELLE", async () => {
    h.published = [tie(), tie({ round: "J2", date: "2026-10-16" })];
    await GET(req());
    expect(h.drifts[0][2]).toEqual(["J2 nouvelle (2026-10-16)"]);
  });

  it("se tait si l'empreinte bouge sans qu'aucun écart suivi n'apparaisse", async () => {
    // L'adresse ne fait pas partie de l'empreinte, mais un import manuel peut couvrir la
    // journée : alerter à vide userait l'attention pour rien.
    h.published = [tie({ venue: "Autre nom" })];
    h.stored = [stored({ venue: "Autre nom" })];
    await GET(req());
    expect(h.drifts).toEqual([]);
  });

  it("un hoquet réseau n'est PAS un calendrier vide", async () => {
    // On ne touche à rien — surtout pas à `snCheckedAt`, qui doit continuer de dire la
    // dernière fois qu'on a vraiment regardé.
    h.fetchThrows = true;
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ checked: 0, failed: 1, drifted: 0 });
    expect(h.teamUpdates).toEqual([]);
    expect(h.drifts).toEqual([]);
  });

  it("DIT aux admins qu'on ne sait plus lire le calendrier, au lieu de compter un échec de plus", async () => {
    // « On ne sait plus lire » et « squashnet n'a pas répondu » n'appellent pas le même geste :
    // l'un demande de reprendre le parsing, l'autre se répare tout seul la semaine suivante. Les
    // confondre dans un compteur muet, c'est laisser le calendrier cesser d'être contrôlé sans
    // que personne l'apprenne — et squashnet a déjà changé son rendu en silence une fois.
    h.fetchUnreadable = true;
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ checked: 0, failed: 1 });
    expect(h.unreadable).toHaveLength(1);
    expect(h.unreadable[0][0]).toEqual(["adm"]);
    expect(h.unreadable[0][1]).toEqual(["Équipe 1"]);
    // Le capitaine n'est PAS destinataire : il n'y peut rien.
    expect(h.drifts).toEqual([]);
  });

  it("un hoquet réseau ordinaire n'alerte personne", async () => {
    h.fetchThrows = true;
    await GET(req());
    expect(h.unreadable).toEqual([]);
  });

  it("ignore les équipes sans ancrage — la requête les exclut déjà", async () => {
    h.teams = [];
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ teams: 0, checked: 0 });
  });
});


describe("le classement, rafraîchi dans la même passe", () => {
  // Pas de cron à lui : le classement ne bouge qu'après une journée de championnat, et cette
  // passe interroge déjà squashnet pour chaque équipe ancrée.

  it("enregistre le classement et sa date", async () => {
    const body = await (await GET(req())).json();
    expect(body.standings).toBe(1);
    const ecrit = h.teamUpdates.find((d) => d.snStandingsJson);
    expect(JSON.parse(ecrit?.snStandingsJson as string)).toEqual(h.standings);
    expect(ecrit?.snStandingsAt).toBeInstanceOf(Date);
  });

  it("un classement indisponible n'emporte PAS le contrôle du calendrier", async () => {
    // Le calendrier est la raison d'être de ce cron ; le classement est un supplément. Les
    // laisser dans le même `try` ferait qu'un squashnet capricieux sur une page annexe
    // masquerait un report de journée.
    h.standingsThrows = true;
    const body = await (await GET(req())).json();
    expect(body.checked).toBe(1);
    expect(body.standingsFailed).toBe(1);
    expect(h.teamUpdates.some((d) => d.snStandingsJson)).toBe(false);
  });

  it("un classement VIDE n'écrase pas celui qu'on a", async () => {
    h.standings = [];
    const body = await (await GET(req())).json();
    expect(body.standings).toBe(0);
    expect(h.teamUpdates.some((d) => d.snStandingsJson)).toBe(false);
  });

  it("saute l'équipe qui n'a pas de division renseignée", async () => {
    // Sans `snDrawId`, la fédération rendrait la division 1 : un tableau crédible d'une autre
    // poule, qu'on enregistrerait sous le nom de notre équipe.
    h.teams = [team({ snDrawId: null })];
    const body = await (await GET(req())).json();
    expect(body.standings).toBe(0);
    expect(body.standingsFailed).toBe(0);
    expect(h.teamUpdates.some((d) => d.snStandingsJson)).toBe(false);
  });

  it("ne tente rien quand le calendrier lui-même n'a pas répondu", async () => {
    h.fetchThrows = true;
    const body = await (await GET(req())).json();
    expect(body.failed).toBe(1);
    expect(body.standings).toBe(0);
  });
});
