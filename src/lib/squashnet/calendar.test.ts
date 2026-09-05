import { describe, it, expect, vi } from "vitest";
import {
  fetchTeamCalendar,
  CalendarUnreadableError,
  parseDayHeading,
  parseTeamCalendar,
  ownFixtures,
  diffCalendar,
  calendarFingerprint,
  matchKey,
  type StoredTie,
  type OwnTie,
} from "./calendar";

/** Ce que squashnet renverra : c'est le seul point d'entrée réseau du module. */
const reseau = vi.hoisted(() => ({ html: "" }));
vi.mock("./client", () => ({ postAjax: async () => reseau.html }));

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

  it("date le PREMIER du mois, qui s'écrit « 1er » et pas « 1 »", () => {
    // La seule irrégularité de la langue qui touche ce format, et elle tombe un jour de
    // championnat comme un autre : le 1er octobre 2026 est un jeudi. L'en-tête ne se datait
    // pas, la journée disparaissait en silence, puis se faisait annoncer « retirée ».
    expect(parseDayHeading("J07 - jeudi 1er octobre 2026")).toEqual({
      round: "J07",
      date: "2026-10-01",
    });
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

  it("TIENT quand squashnet ajoute des classes utilitaires à ses conteneurs", () => {
    // Le mode de panne que ce module dit combattre, et qui l'atteignait quand même. Les quatre
    // découpages exigeaient la classe EXACTE (`class='row'`, pas `class='row mt-2'`) : une
    // classe Bootstrap ajoutée n'importe où faisait lire ZÉRO rencontre, l'écart classait TOUT
    // le calendrier en « retirée », et le capitaine recevait « J01…J05 retirée du calendrier »
    // sur un calendrier intact. C'est exactement la retouche que squashnet a déjà faite en
    // silence le 2026-08-26 sur ses guillemets.
    const bootstrappe = q(FRAGMENT)
      .replace(/class=(['"])b-day\1/g, "class=$1b-day mb-3$1")
      .replace(/class=(['"])row\1/g, "class=$1row mt-2 g-0$1")
      .replace(/class=(['"])match\1/g, "class=$1match shadow-sm$1")
      .replace(/class=(['"])mb-0\1/g, "class=$1mb-0 text-muted$1");
    expect(parseTeamCalendar(bootstrappe)).toEqual(parseTeamCalendar(q(FRAGMENT)));
  });

  it("ne confond PAS une classe avec un morceau d'une autre", () => {
    // Le revers de la tolérance : `\brow\b` répondrait aussi à `form-row`, le tiret étant une
    // frontière de mot. Une rangée fantôme découperait le calendrier au mauvais endroit — un
    // découpage faux est pire qu'une panne, parce qu'il se lit.
    const leurre = q(FRAGMENT).replace(
      /<div class=(['"])schedule\1>/g,
      "<div class=$1form-row not-a-match$1>",
    );
    expect(parseTeamCalendar(leurre)).toEqual(parseTeamCalendar(q(FRAGMENT)));
  });

  it("ne laisse PAS le pied de page déborder dans la dernière rencontre", () => {
    // Le découpage ne borne pas à droite : la dernière rencontre de la dernière journée courait
    // jusqu'à la fin du document. Tant que le pied de page ne portait rien d'exploitable, cela
    // ne se voyait pas — et aucun test ne tenait cette condition. Une rencontre dont la ligue ne
    // publie pas le club hôte allait alors chercher le PREMIER `<p class='mb-0'>` venu, c'est-à-
    // dire celui du pied de page : un lieu inventé, sur une convocation.
    //
    // Chaque rencontre est désormais bornée à son bloc `players`, dont la fermante est trouvable
    // exactement (il ne contient aucun `<div>`).
    const sansLieu = day(
      "J9 - mardi 12 mai 2026",
      "20:00",
      `<div class='match'><div class='players'><p class='mb-0'><a data-teamid='${OURS}'>Yvette 1</a>
</p>
<span class='mb-0'>vs</span><p class='mb-0'><a data-teamid='161039'>Montmartre 1</a>
</p>
</div>
</div>`,
    );
    const pied = `<div class='footer'><p class='mb-0'>SQUASH DE NULLE PART</p></div>`;
    const lues = parseTeamCalendar(q(sansLieu) + q(pied));
    expect(lues).toHaveLength(1);
    expect(lues[0].venue).toBeNull();
  });

  it("lit une adresse en ENTIER, même balisée", () => {
    // On coupait au premier `</` venu : « 12 RUE <b>DU</b> STADE, 91440 - ORSAY » se lisait
    // « 12 RUE DU ». Une adresse tronquée a l'air d'une adresse — personne ne la rattrape, et
    // c'est l'information la plus utile en déplacement.
    const balisee = q(FRAGMENT).replace(
      "BUREAUX DE LA COLLINE, 338 RUE ROYALE,",
      "BUREAUX DE LA <b>COLLINE</b>, 338 RUE ROYALE,",
    );
    expect(parseTeamCalendar(balisee)[0].venueAddress).toBe(
      "BUREAUX DE LA COLLINE, 338 RUE ROYALE, 92210 - ST CLOUD",
    );
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

  it("SIGNALE un statut de date qui diverge, sans jamais le mettre à corriger", () => {
    // « confirmée » n'est pas publié : c'est une DÉDUCTION, avec deux angles morts que l'admin
    // corrige à la main. La classer parmi les corrections la faisait réécrire par le premier
    // « Appliquer » venu — celui d'un lieu changé trois semaines plus tard —, et l'équipe
    // cessait d'être convoquée sans un mot. Elle se signale, elle ne s'applique pas.
    const d = diffCalendar([stored({ dateConfirmed: false })], [own()], EVENT);
    expect(d.toUpdate).toEqual([]);
    expect(d.unchanged).toBe(1);
    expect(d.confirmDrift).toEqual([{ id: "f1", round: "J1", stored: false, published: true }]);
  });

  it("signale la divergence dans l'autre sens aussi", () => {
    // Le symétrique compte autant : une correction « ferme » posée à la main sur une journée
    // que la ligue publie encore comme bouchon ne doit pas être révoquée non plus.
    const d = diffCalendar([stored()], [own({ dateConfirmed: false })], EVENT);
    expect(d.toUpdate).toEqual([]);
    expect(d.confirmDrift).toEqual([{ id: "f1", round: "J1", stored: true, published: false }]);
  });

  it("ne signale rien quand les deux s'accordent", () => {
    expect(diffCalendar([stored()], [own()], EVENT).confirmDrift).toEqual([]);
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

  it("SIGNALE une journée que la ligue ne publie plus", () => {
    // Sans cette liste, une journée retirée du calendrier restait en base pour toujours, et le
    // cron quotidien ouvrait consciencieusement son appel de disponibilité pour une soirée qui
    // n'existe plus. On la signale ; on ne la supprime jamais d'office.
    // La rencontre stockée porte la journée J7 — sa CLÉ et sa colonne `round` s'accordent.
    // Elles se contredisaient (`ev1:J7` sur une ligne annoncée « J1 »), et rien n'aurait révélé
    // une confusion entre les deux. Cet accord est tenu par l'import, qui les pose ensemble, et
    // par le `PATCH`, qui refait la clé quand on corrige la journée.
    const d = diffCalendar(
      [stored({ id: "x", round: "J7", snMatchKey: matchKey(EVENT, "J7") })],
      [own()],
      EVENT,
    );
    expect(d.toDelete).toEqual([
      { id: "x", round: "J7", date: "2026-10-09", opponent: "Montmartre 1" },
    ]);
  });

  it("ne déclare disparue NI une rencontre manuelle, NI celle d'un autre événement", () => {
    // Les deux se ressemblent à l'écran et ne veulent pas dire la même chose : l'une n'a jamais
    // été publiée, l'autre l'a été par une saison précédente. Les compter comme retirées
    // signalerait chaque année tout le calendrier de la précédente.
    const manuelle = stored({ id: "m", snMatchKey: null });
    const vieille = stored({ id: "v", snMatchKey: matchKey("ev0", "J9") });
    const d = diffCalendar([manuelle, vieille], [own()], EVENT);
    expect(d.toDelete).toEqual([]);
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

  it("BOUGE quand le statut de la date change — c'est la seule voie qui reste", () => {
    // L'empreinte porte `round|date|time|H/A|opponent|venue` : sans le statut, deux calendriers
    // ne différant que par lui rendaient la même empreinte, et le contrôle hebdomadaire se
    // taisait. Notre J3 devenue prévisionnelle parce qu'elle partageait sa date avec une
    // journée où l'on est exempt, puis redevenue ferme quand la ligue replanifiait l'autre : la
    // base gardait « prévisionnelle » et l'équipe n'était jamais convoquée pour une rencontre
    // bien réelle. Et depuis que l'import ne réécrit plus ce champ, cette alerte est le seul
    // chemin par lequel l'écart atteint un humain.
    expect(calendarFingerprint([own({ dateConfirmed: false })])).not.toBe(
      calendarFingerprint([own()]),
    );
  });

  it("ignore l'adresse, qui n'a jamais fait déplacer personne d'un jour", () => {
    // Une adresse reformatée côté fédération ne doit pas réveiller le capitaine un lundi
    // matin. Elle s'appliquera au prochain import réel.
    expect(calendarFingerprint([own({ venueAddress: "autre écriture" })])).toBe(
      calendarFingerprint([own()]),
    );
  });
});

describe("fetchTeamCalendar — quand on ne sait plus lire", () => {
  // « LA POULE EST VIDE » ET « LE RENDU A CHANGÉ » se ressemblent : dans les deux cas on rend
  // zéro rencontre. Ils n'appellent pourtant pas la même réaction, et le second coûte cher —
  // zéro rencontre fait classer TOUT le calendrier en « retirée », et le capitaine reçoit
  // « J01…J05 retirée du calendrier » sur un calendrier parfaitement intact.

  it("JETTE quand le fragment montre des journées mais qu'on n'en tire aucune rencontre", async () => {
    // Les en-têtes sont datables, donc c'est bien un calendrier ; les rencontres, elles, ne se
    // lisent plus. C'est notre lecture qui est périmée, et cela ne se réessaie pas.
    reseau.html = FRAGMENT.replace(/data-teamid=/g, "data-equipe=");
    await expect(fetchTeamCalendar("ev1", "r1")).rejects.toBeInstanceOf(CalendarUnreadableError);
  });

  it("rend une liste vide sans jeter quand il n'y a PAS de journée publiée", async () => {
    // Une poule non encore planifiée est un cas normal : la signaler comme une panne enverrait
    // chercher un bug là où il n'y a qu'une ligue en retard.
    reseau.html = "<div class='schedule'>Aucune rencontre programmée</div>";
    await expect(fetchTeamCalendar("ev1", "r1")).resolves.toEqual([]);
  });

  it("ne jette pas sur un calendrier qui se lit", async () => {
    reseau.html = FRAGMENT;
    await expect(fetchTeamCalendar("ev1", "r1")).resolves.toHaveLength(5);
  });
});
