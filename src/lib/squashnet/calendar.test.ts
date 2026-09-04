import { describe, it, expect } from "vitest";
import {
  parseDayHeading,
  parseTeamCalendar,
  ownFixtures,
  diffCalendar,
  calendarFingerprint,
  matchKey,
  type StoredTie,
  type OwnTie,
} from "./calendar";

// Fragment RÉEL capté sur squashnet.fr (POST ic_a=393986, Critérium IDF équipes Hommes 2025-26).
// La J1 est authentique, structure et libellés compris. Les journées suivantes sont bâties sur
// le même moule pour couvrir ce que la J1 seule ne montre pas :
//   * J2 : notre équipe joue, à l'extérieur ;
//   * J3 et J4 : deux journées à la MÊME date — la signature de la date bouchon, observée sur
//     l'événement réel où J11 à J14 tombaient toutes le « mardi 30 juin 2026 ».
//
// ⚠️ Les guillemets sont SIMPLES ici et doublés par `dq` dans le second passage : le
// 2026-08-26, squashnet a basculé tout son HTML d'attributs sans toucher à la structure, et le
// parsing du classement a cassé net (l'admin ne voyait plus qu'« indisponible » alors que le
// site était debout). On ne sait pas lequel des deux rendus il servira demain.

const OURS = "161092"; // l'Yvette, dans cet événement

const tie = (homeId: string, homeName: string, awayId: string, awayName: string, venue: string, addr: string) =>
  `<div class='match'><div class='players'><p class='mb-0'><a href='#' data-ic_t='event-datas' class='ic-click' data-ic_a='393480' data-ic_ajax='1' data-teamid='${homeId}'>${homeName}</a>
</p>
<span class='mb-0'>vs</span><p class='mb-0'><a href='#' data-ic_t='event-datas' class='ic-click' data-ic_a='393480' data-ic_ajax='1' data-teamid='${awayId}'>${awayName}</a>
</p>
<p class='mb-0'>${venue}</p>
<p class='tie-address mb-0'>${addr}</p>
</div>
</div>`;

const day = (heading: string, time: string, matches: string) =>
  `<div class='b-day'><div id='flex'><h2>${heading}</h2>
</div>
<div class='schedule'><div class='row'><div class='time'><span>${time}</span></div>
${matches}</div>
</div>
</div>`;

const J1 = day(
  "J1 - mardi 28 avril 2026",
  "20:00",
  tie(
    "161040",
    "Ms Sec St Cloud 1",
    "161039",
    "Montmartre 1",
    "SAINT CLOUD 92 SQUASH CLUB",
    "BUREAUX DE LA COLLINE, 338 RUE ROYALE,<br> 92210 - ST CLOUD",
  ) +
    tie(
      "161037",
      "Jeu de Paume 1",
      OURS,
      "Yvette 1",
      "SOCIETE SPORTIVE DU JEU DE PAUME ET DE RACKETS",
      "74 TER RUE LAURISTON,<br> 75116 - PARIS",
    ),
);

const J2 = day(
  "J2 - mardi 05 mai 2026",
  "20:30",
  tie(OURS, "Yvette 1", "161043", "Squash Pyramides 1", "SQUASH DE L YVETTE", "1 RUE DU SQUASH,<br> 91400 - ORSAY"),
);

// Deux journées au même jour : la fédération n'a pas encore planifié.
const J3 = day(
  "J3 - mardi 30 juin 2026",
  "20:00",
  tie(OURS, "Yvette 1", "161044", "Vincennes 1", "SQUASH DE L YVETTE", "1 RUE DU SQUASH,<br> 91400 - ORSAY"),
);
const J4 = day(
  "J4 - mardi 30 juin 2026",
  "20:00",
  tie("161042", "PUC 1", OURS, "Yvette 1", "STADE CHARLETY", "17 AVE PIERRE DE COUBERTIN,<br> 75013 - PARIS"),
);

const FRAGMENT = `<div class='div-event-content'><div class='b-planning calendar'>${J1}${J2}${J3}${J4}</div></div>`;

/** Le rendu « guillemets doubles » de 2026-08 : aucun `'` n'apparaît dans le texte. */
const dq = (html: string) => html.replace(/'/g, '"');

describe("parseDayHeading", () => {
  it("lit la journée et la date, et jette le jour de la semaine", () => {
    // Le jour de la semaine est redondant avec la date : s'en servir reviendrait à faire
    // confiance à squashnet sur un point que la date tranche déjà.
    expect(parseDayHeading("J1 - mardi 28 avril 2026")).toEqual({ round: "J1", date: "2026-04-28" });
  });

  it("gère les mois accentués et le jour sur un chiffre", () => {
    expect(parseDayHeading("J7 - jeudi 4 février 2027")).toEqual({ round: "J7", date: "2027-02-04" });
    expect(parseDayHeading("J9 - lundi 31 août 2026")).toEqual({ round: "J9", date: "2026-08-31" });
    expect(parseDayHeading("J2 - mardi 05 décembre 2026")).toEqual({ round: "J2", date: "2026-12-05" });
  });

  it("renvoie null sur une forme inattendue plutôt qu'une date inventée", () => {
    // Une journée qu'on ne sait pas dater ne doit PAS entrer dans le calendrier : elle
    // convoquerait l'équipe un jour choisi par un bug.
    expect(parseDayHeading("J1 - mardi 28 brumaire 2026")).toBeNull();
    expect(parseDayHeading("À planifier")).toBeNull();
    expect(parseDayHeading("")).toBeNull();
  });
});

describe.each([
  ["guillemets simples", (h: string) => h],
  ["guillemets doubles (rendu 2026-08)", dq],
])("parseTeamCalendar — %s", (_label, q) => {
  it("rend toutes les rencontres de l'événement, pas seulement les nôtres", () => {
    // Le paramètre `teamid` de squashnet ne filtre RIEN : on reçoit l'événement entier.
    expect(parseTeamCalendar(q(FRAGMENT))).toHaveLength(5);
  });

  it("extrait tous les champs d'une rencontre réelle", () => {
    expect(parseTeamCalendar(q(FRAGMENT))[0]).toEqual({
      round: "J1",
      date: "2026-04-28",
      time: "20:00",
      homeTeamId: "161040",
      homeTeamName: "Ms Sec St Cloud 1",
      awayTeamId: "161039",
      awayTeamName: "Montmartre 1",
      venue: "SAINT CLOUD 92 SQUASH CLUB",
      // Le <br> de l'adresse devient une espace, pas rien : sans quoi le code postal se
      // collerait à la rue.
      venueAddress: "BUREAUX DE LA COLLINE, 338 RUE ROYALE, 92210 - ST CLOUD",
    });
  });

  it("lit l'heure de CHAQUE rangée, pas une seule pour tout l'événement", () => {
    const ties = parseTeamCalendar(q(FRAGMENT));
    expect(ties.find((t) => t.round === "J1")?.time).toBe("20:00");
    expect(ties.find((t) => t.round === "J2")?.time).toBe("20:30");
  });

  it("ignore une journée dont l'en-tête est illisible", () => {
    const cassé = day("À planifier", "20:00", tie(OURS, "Yvette 1", "161039", "X", "Y", "Z"));
    expect(parseTeamCalendar(q(cassé))).toEqual([]);
  });

  it("ne rend rien sur un fragment vide, sans jeter", () => {
    expect(parseTeamCalendar(q("<div>rien du tout</div>"))).toEqual([]);
  });
});

describe("ownFixtures", () => {
  const ties = parseTeamCalendar(FRAGMENT);

  it("ne retient que nos rencontres", () => {
    expect(ownFixtures(ties, OURS).map((t) => t.round)).toEqual(["J1", "J2", "J3", "J4"]);
  });

  it("dit qui reçoit et nomme le bon adversaire", () => {
    const [j1, j2] = ownFixtures(ties, OURS);
    expect(j1).toMatchObject({ home: false, opponent: "Jeu de Paume 1" });
    expect(j2).toMatchObject({ home: true, opponent: "Squash Pyramides 1" });
  });

  it("marque comme NON CONFIRMÉE une date partagée par plusieurs journées", () => {
    // La signature de la date bouchon, observée sur l'événement réel (J11 à J14 toutes au
    // 30 juin). Prendre cette date au sérieux convoquerait l'équipe deux fois le même soir.
    const own = ownFixtures(ties, OURS);
    expect(own.find((t) => t.round === "J1")?.dateConfirmed).toBe(true);
    expect(own.find((t) => t.round === "J3")?.dateConfirmed).toBe(false);
    expect(own.find((t) => t.round === "J4")?.dateConfirmed).toBe(false);
  });

  it("ne prend pas deux rencontres d'une MÊME journée pour un bouchon", () => {
    // Une journée compte quatre rencontres à la même date : c'est normal. Ce qu'on compte,
    // c'est le nombre de JOURNÉES par date, pas le nombre de rencontres.
    const own = ownFixtures(parseTeamCalendar(J1), "161040");
    expect(own[0].dateConfirmed).toBe(true);
  });

  it("rend une liste vide quand notre équipe ne joue pas cet événement", () => {
    expect(ownFixtures(ties, "999999")).toEqual([]);
  });
});

describe("diffCalendar", () => {
  const EVENT = "ev1";
  const own = (over: Partial<OwnTie> = {}): OwnTie => ({
    round: "J1",
    date: "2026-10-09",
    time: "20:00",
    home: true,
    opponent: "Montmartre 1",
    venue: "SQUASH DE L YVETTE",
    venueAddress: "1 RUE DU SQUASH, 91400 - ORSAY",
    dateConfirmed: true,
    ...over,
  });
  const stored = (over: Partial<StoredTie> = {}): StoredTie => ({
    id: "f1",
    round: "J1",
    date: "2026-10-09",
    time: "20:00",
    home: true,
    opponent: "Montmartre 1",
    venue: "SQUASH DE L YVETTE",
    venueAddress: "1 RUE DU SQUASH, 91400 - ORSAY",
    dateConfirmed: true,
    snMatchKey: matchKey(EVENT, "J1"),
    ...over,
  });

  it("propose à la création une journée qu'on n'a pas", () => {
    const d = diffCalendar([], [own()], EVENT);
    expect(d.toCreate).toHaveLength(1);
    expect(d.toUpdate).toEqual([]);
    expect(d.unchanged).toBe(0);
  });

  it("ne signale rien quand tout coïncide", () => {
    const d = diffCalendar([stored()], [own()], EVENT);
    expect(d).toMatchObject({ toCreate: [], toUpdate: [], unchanged: 1 });
  });

  it("rapproche par JOURNÉE et non par date : un report se corrige, il ne se duplique pas", () => {
    // C'est tout l'intérêt de `round`. Rapprocher par date créerait une rencontre de plus à
    // chaque report, et l'équipe verrait deux J7.
    const d = diffCalendar([stored()], [own({ date: "2026-10-16" })], EVENT);
    expect(d.toCreate).toEqual([]);
    expect(d.toUpdate).toHaveLength(1);
    expect(d.toUpdate[0].id).toBe("f1");
    expect(d.toUpdate[0].changes).toEqual([
      { field: "date", from: "2026-10-09", to: "2026-10-16" },
    ]);
  });

  it("liste CHAQUE champ qui bouge, avec l'avant et l'après", () => {
    // L'admin doit voir ce qu'il applique : un import qui annonce « 3 modifications » sans
    // dire lesquelles ne se valide pas, il se subit.
    const d = diffCalendar([stored()], [own({ time: "20:30", home: false, opponent: "PUC 1" })], EVENT);
    expect(d.toUpdate[0].changes).toEqual([
      { field: "time", from: "20:00", to: "20:30" },
      { field: "home", from: "true", to: "false" },
      { field: "opponent", from: "Montmartre 1", to: "PUC 1" },
    ]);
  });

  it("voit une date qui devient ferme, ou qui cesse de l'être", () => {
    const d = diffCalendar([stored({ dateConfirmed: false })], [own()], EVENT);
    expect(d.toUpdate[0].changes).toEqual([
      { field: "dateConfirmed", from: "false", to: "true" },
    ]);
  });

  it("NE TOUCHE JAMAIS une rencontre saisie à la main, même sur la même journée", () => {
    // Même doctrine que les corrections de classement : l'automatique et l'humain ne partagent
    // aucune colonne. La rencontre manuelle est ignorée, et son homologue fédérale est proposée
    // à la création — c'est à un humain de trancher, pas à un rapprochement approximatif.
    const manuelle = stored({ snMatchKey: null, date: "2026-10-02" });
    const d = diffCalendar([manuelle], [own()], EVENT);
    expect(d.toUpdate).toEqual([]);
    expect(d.toCreate).toHaveLength(1);
  });

  it("ignore les journées d'un AUTRE événement portant le même numéro", () => {
    // La clé est « événement:journée » : la J1 de la saison passée ne doit pas se faire
    // corriger par la J1 de la nouvelle.
    const vieille = stored({ snMatchKey: matchKey("ev0", "J1") });
    const d = diffCalendar([vieille], [own()], EVENT);
    expect(d.toCreate).toHaveLength(1);
    expect(d.toUpdate).toEqual([]);
  });
});

describe("calendarFingerprint", () => {
  const own = (over: Partial<OwnTie> = {}): OwnTie => ({
    round: "J1",
    date: "2026-10-09",
    time: "20:00",
    home: true,
    opponent: "Montmartre 1",
    venue: "V",
    venueAddress: "A",
    dateConfirmed: true,
    ...over,
  });

  it("ne bouge pas quand l'ordre des lignes change", () => {
    // L'ordre de rendu n'est pas garanti par squashnet ; le tenir pour significatif ferait
    // crier à la dérive une semaine sur deux.
    const a = own();
    const b = own({ round: "J2", date: "2026-10-16" });
    expect(calendarFingerprint([a, b])).toBe(calendarFingerprint([b, a]));
  });

  it("bouge dès qu'une date, une heure ou un adversaire change", () => {
    const base = calendarFingerprint([own()]);
    expect(calendarFingerprint([own({ date: "2026-10-16" })])).not.toBe(base);
    expect(calendarFingerprint([own({ time: "21:00" })])).not.toBe(base);
    expect(calendarFingerprint([own({ opponent: "PUC 1" })])).not.toBe(base);
    expect(calendarFingerprint([own({ home: false })])).not.toBe(base);
  });

  it("ignore l'adresse, qui n'a jamais fait déplacer personne d'un jour", () => {
    // Une adresse reformatée côté fédération ne doit pas réveiller le capitaine un lundi
    // matin. Elle s'appliquera au prochain import réel.
    expect(calendarFingerprint([own({ venueAddress: "autre écriture" })])).toBe(
      calendarFingerprint([own()]),
    );
  });
});
