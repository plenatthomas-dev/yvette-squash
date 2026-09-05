import { postAjax } from "./client";

// ============================================================================
//  CALENDRIER D'UN CHAMPIONNAT PAR ÉQUIPES (squashnet.fr), source PUBLIQUE.
//
//  Même rétro-ingénierie que le classement, même point d'entrée (`index.php`),
//  seul `ic_a` change : 393986 rend la section « Calendrier » d'un événement,
//  en HTML rendu serveur. Pas d'authentification, pas de cookie.
//
//  TROIS CHOSES OBSERVÉES SUR LE VRAI SITE, et qui commandent tout ce module :
//
//   1. LE PARAMÈTRE `teamid` NE FILTRE RIEN. Avec `roundid`, on reçoit la POULE
//      ENTIÈRE — mesuré sur la nôtre : six équipes, cinq journées, quinze
//      rencontres, dont cinq sont les nôtres. C'est donc à nous de retenir les
//      lignes où notre équipe figure — d'où `ownFixtures`.
//
//   2. LES JOURNÉES NON PLANIFIÉES PORTENT UNE DATE BOUCHON. Sur l'événement
//      d'essai, J11 à J14 tombent toutes le « mardi 30 juin 2026 ». Prendre
//      cette date au sérieux convoquerait l'équipe quatre fois le même soir.
//      On la repère à sa signature — plusieurs journées le même jour — et on
//      marque ces rencontres `dateConfirmed: false`, ce qui suffit à couper
//      toute notification les concernant.
//
//   3. LE JOUR DE LA SEMAINE N'EST PAS GARANTI. L'événement d'essai se joue le
//      MARDI. Rien ici ne suppose un jeudi : la date vient du calendrier.
//
//  Le parsing est PUR et exporté, testé sur fragment réel. Il tolère les
//  guillemets simples ET doubles : squashnet a basculé tout son HTML des uns
//  aux autres le 2026-08-26 sans prévenir, et le classement a cassé net.
// ============================================================================

/** Action AJAX de la section « Calendrier » d'un événement par équipes. */
const CALENDAR_ACTION = "393986";

/** Une rencontre du calendrier fédéral, telle qu'elle est publiée. */
export interface CalendarTie {
  /** Journée de championnat, ex. « J1 ». */
  round: string;
  /** Date publiée, « YYYY-MM-DD ». */
  date: string;
  /** Heure de début, « HH:MM », ou null si la ligne n'en porte pas. */
  time: string | null;
  /** Identifiant squashnet de l'équipe qui reçoit. */
  homeTeamId: string;
  homeTeamName: string;
  awayTeamId: string;
  awayTeamName: string;
  /** Club hôte et son adresse postale, tels que publiés. */
  venue: string | null;
  venueAddress: string | null;
}

/** Une de NOS rencontres, une fois le calendrier réduit à notre équipe. */
export interface OwnTie {
  round: string;
  date: string;
  time: string | null;
  /** Vrai si c'est nous qui recevons. */
  home: boolean;
  /** Nom de l'équipe adverse, tel que publié. */
  opponent: string;
  venue: string | null;
  venueAddress: string | null;
  /**
   * Faux quand la date est un BOUCHON (cf. l'en-tête). Une rencontre non confirmée s'affiche,
   * mais ne déclenche ni appel de disponibilité ni relance : annoncer une soirée qui n'existe
   * pas coûte plus cher que de n'annoncer rien.
   */
  dateConfirmed: boolean;
}

// --- Parsing (PUR, exporté pour les tests) ---------------------------------

const MONTHS: Record<string, string> = {
  janvier: "01",
  "février": "02",
  fevrier: "02",
  mars: "03",
  avril: "04",
  mai: "05",
  juin: "06",
  juillet: "07",
  "août": "08",
  aout: "08",
  septembre: "09",
  octobre: "10",
  novembre: "11",
  "décembre": "12",
  decembre: "12",
};

/**
 * Retire les balises et normalise les espaces. `<br>` devient une espace, pas rien.
 *
 * Les entités décodées sont les MÊMES que celles du classement (`standings.texte`), apostrophe
 * comprise. Les deux modules lisent les mêmes noms d'équipe : deux politiques de décodage, et
 * ils cesseraient de les normaliser pareil le jour où squashnet arrêterait de servir de l'UTF-8
 * brut — « Squash de l'Yvette » d'un côté, « Squash de &#39;Yvette » de l'autre, et un
 * rapprochement qui échoue sans rien dire.
 */
function stripTags(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * « J1 - mardi 28 avril 2026 » → `{ round: "J1", date: "2026-04-28" }`.
 *
 * Le jour de la semaine est LU ET JETÉ : il est redondant avec la date, et s'en servir
 * reviendrait à faire confiance à squashnet sur un point que la date tranche déjà.
 * Renvoie null sur tout ce qui ne ressemble pas à cette forme — une journée qu'on ne sait pas
 * dater ne doit pas entrer dans le calendrier avec une date inventée.
 *
 * ⚠️ LE PREMIER DU MOIS S'ÉCRIT « 1er » EN FRANÇAIS, et c'est la seule irrégularité de la
 * langue qui touche ce format. « J07 - jeudi 1er octobre 2026 » ne se datait pas : la journée
 * disparaissait en silence, puis se faisait annoncer « retirée du calendrier ». Le 1er octobre
 * 2026 est un jeudi, c'est-à-dire un jour de championnat parfaitement ordinaire.
 */
export function parseDayHeading(text: string): { round: string; date: string } | null {
  const m = /^\s*(\S+)\s*-\s*\S+\s+(\d{1,2})(?:er)?\s+([^\s]+)\s+(\d{4})\s*$/.exec(stripTags(text));
  if (!m) return null;
  const [, round, day, monthWord, year] = m;
  const month = MONTHS[monthWord.toLowerCase()];
  if (!month) return null;
  return { round, date: `${year}-${month}-${day.padStart(2, "0")}` };
}

// --- Lecture des classes : UNE SEULE POLITIQUE, tolérante ------------------
//
// Le module en appliquait deux. `classText` tolérait les classes supplémentaires, mais les
// quatre DÉCOUPAGES exigeaient la classe EXACTE : `class='row'` et non `class='row mt-2'`. Une
// classe utilitaire Bootstrap ajoutée n'importe où — exactement la retouche que squashnet a
// déjà faite en silence le 2026-08-26, que l'en-tête de ce fichier cite trois fois — faisait
// lire ZÉRO rencontre. Et zéro rencontre, ce n'est pas rien : l'écart classe alors TOUT le
// calendrier en « retirée », et le capitaine reçoit « J01…J05 retirée du calendrier », message
// parfaitement crédible sur un calendrier intact.
//
// La comparaison se fait AU JETON, et non au `\b` : `\brow\b` répondrait aussi à
// `class='form-row'`, le tiret étant une frontière de mot. C'est le genre de tolérance qui
// remplace une panne bruyante par un découpage faux, ce qui est pire.

/** La valeur de l'attribut `class` d'une balise ouvrante, telle quelle. */
const classAttr = (attrs: string) => /\bclass=['"]([^'"]*)['"]/.exec(attrs)?.[1] ?? "";

/** « Cette balise porte-t-elle cette classe ? », au jeton près. */
const hasClass = (attrs: string, cls: string) => classAttr(attrs).split(/\s+/).includes(cls);

/**
 * Contenu texte du premier élément portant cette classe, ou « » s'il n'y en a pas.
 *
 * On coupe à la première FERMANTE DE MÊME NOM, et non au premier `</` venu : l'adresse
 * « 12 RUE <b>DU</b> STADE, 91440 - ORSAY » se lisait « 12 RUE DU » — une adresse tronquée qui
 * a l'air d'une adresse, donc que personne ne rattrape. Cela ne tenait que parce que le seul
 * balisage rencontré jusqu'ici dans une adresse est un `<br>`, qui n'a pas de fermante.
 */
function classText(html: string, cls: string): string {
  return stripTags(classHtml(html, cls));
}

/**
 * Le contenu BRUT du premier élément portant cette classe — le même découpage, sans stripTags.
 *
 * Il sert à BORNER, là où `classText` sert à lire : la dernière rencontre d'une journée court
 * sinon jusqu'à la fin du document (`splitOn` ne borne pas à droite, faute d'analyse
 * d'imbrication), et tout ce qui suit — pied de page compris — se retrouverait candidat au lieu
 * ou aux équipes. `<div class='players'>` ne contient aucun `<div>` : la première fermante de
 * même nom EST la sienne, et la borne est donc exacte.
 */
function classHtml(html: string, cls: string): string {
  for (const m of html.matchAll(/<(\w+)\b([^>]*)>/g)) {
    if (!hasClass(m[2], cls)) continue;
    const reste = html.slice(m.index + m[0].length);
    const fin = reste.search(new RegExp(`</${m[1]}\\b`, "i"));
    return fin === -1 ? reste : reste.slice(0, fin);
  }
  return "";
}

/**
 * Découpe le fragment aux balises ouvrantes portant cette classe, et rend ce qui SUIT chacune.
 *
 * Même sémantique que le `split(…).slice(1)` qu'elle remplace, la tolérance en plus.
 *
 * ⚠️ LE DERNIER MORCEAU N'EST PAS BORNÉ À DROITE : il court jusqu'à la fin du fragment reçu, y
 * compris ce qui suit la fin réelle de l'élément. Sans analyse d'imbrication on ne peut pas
 * faire mieux ICI — c'est donc l'appelant qui borne, en réduisant chaque rencontre à son bloc
 * `players` (cf. `parseTeamCalendar`), le seul élément dont la fermante est trouvable
 * exactement. Ne pas se fier à ce découpage seul pour délimiter un contenu.
 */
function splitOn(html: string, tag: string, cls: string): string[] {
  const parts: string[] = [];
  let debut = -1;
  for (const m of html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, "gi"))) {
    if (!hasClass(m[1], cls)) continue;
    if (debut >= 0) parts.push(html.slice(debut, m.index));
    debut = m.index + m[0].length;
  }
  if (debut >= 0) parts.push(html.slice(debut));
  return parts;
}

/**
 * Parse le fragment « Calendrier » en rencontres.
 *
 * Découpage en trois étages, qui suit celui du HTML : une JOURNÉE (`b-day`) porte son titre et
 * une ou plusieurs RANGÉES (`row`), chaque rangée porte SON heure et ses rencontres (`match`).
 * L'heure est donc lue au niveau de la rangée et non de la journée : sur l'événement d'essai
 * une journée n'a qu'une rangée, mais rien ne l'impose et une journée à deux horaires ferait
 * autrement porter l'heure de la première moitié à toute la seconde.
 */
export function parseTeamCalendar(html: string): CalendarTie[] {
  const ties: CalendarTie[] = [];
  const days = splitOn(html, "div", "b-day");
  for (const day of days) {
    const heading = /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(day);
    const parsed = heading ? parseDayHeading(heading[1]) : null;
    if (!parsed) continue;

    for (const row of splitOn(day, "div", "row")) {
      const time = /^\d{2}:\d{2}$/.test(classText(row, "time")) ? classText(row, "time") : null;
      for (const brut of splitOn(row, "div", "match")) {
        // LA RENCONTRE EST BORNÉE À SON BLOC `players`, et non au reste du fragment.
        //
        // `splitOn` ne borne pas à droite : la dernière rencontre de la dernière journée courait
        // jusqu'à la fin du document. Rien n'en souffrait tant que le pied de page ne portait ni
        // `data-teamid` ni `<p class='mb-0'>` — une condition qu'aucun test ne tenait, et qu'une
        // fixture recapturée pouvait rompre en silence. `players` enveloppe exactement ce qu'on
        // lit ici, et ne contient aucun `<div>` : sa fermante est trouvable sans ambiguïté.
        //
        // Repli sur le fragment entier si le bloc disparaît du rendu : on retombe alors sur le
        // comportement d'avant, plutôt que de ne plus rien lire du tout.
        const match = classHtml(brut, "players") || brut;
        // Les deux équipes sont les deux seuls liens porteurs d'un `data-teamid`, dans
        // l'ordre domicile puis extérieur — c'est ce que le rendu garantit, et c'est la seule
        // chose qui distingue « on reçoit » de « on se déplace ».
        const teams = [...match.matchAll(/data-teamid=['"](\d+)['"][^>]*>([\s\S]*?)<\/a>/g)];
        if (teams.length < 2) continue;
        // Le club hôte est le seul `<p>` de la rencontre qui ne contienne pas de lien : les
        // autres enveloppent les noms d'équipe. Chercher « le 3e <p> » marcherait aujourd'hui
        // et casserait au premier <p> ajouté.
        const plainP = [...match.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)]
          // L'adresse porte elle aussi `mb-0` (`<p class='tie-address mb-0'>`), et elle est
          // lue à part : la compter ici ferait dépendre le lieu de l'ordre des paragraphes.
          .filter((m) => hasClass(m[1], "mb-0") && !hasClass(m[1], "tie-address"))
          .map((m) => m[2])
          .filter((inner) => !/<a\b/i.test(inner))
          .map(stripTags)
          .filter(Boolean);
        ties.push({
          round: parsed.round,
          date: parsed.date,
          time,
          homeTeamId: teams[0][1],
          homeTeamName: stripTags(teams[0][2]),
          awayTeamId: teams[1][1],
          awayTeamName: stripTags(teams[1][2]),
          venue: plainP[0] ?? null,
          venueAddress: classText(match, "tie-address") || null,
        });
      }
    }
  }
  return ties;
}

/**
 * Réduit le calendrier de l'événement aux rencontres de NOTRE équipe, et marque celles dont la
 * date est un bouchon.
 *
 * La détection du bouchon se fait sur la POULE ENTIÈRE, avant filtrage : c'est là que la
 * signature est visible (quatre journées le même jour). La chercher après filtrage ne verrait
 * qu'une de nos rencontres par date, donc rien du tout.
 */
export function ownFixtures(ties: CalendarTie[], snTeamId: string): OwnTie[] {
  const roundsByDate = new Map<string, Set<string>>();
  for (const t of ties) {
    const set = roundsByDate.get(t.date) ?? new Set<string>();
    set.add(t.round);
    roundsByDate.set(t.date, set);
  }
  return ties
    .filter((t) => t.homeTeamId === snTeamId || t.awayTeamId === snTeamId)
    .map((t) => {
      const home = t.homeTeamId === snTeamId;
      return {
        round: t.round,
        date: t.date,
        time: t.time,
        home,
        opponent: home ? t.awayTeamName : t.homeTeamName,
        venue: t.venue,
        venueAddress: t.venueAddress,
        // Plusieurs JOURNÉES distinctes le même jour = date de remplissage. Deux rencontres
        // d'une MÊME journée partagent évidemment leur date : c'est bien le nombre de journées
        // qu'on compte, pas le nombre de rencontres.
        //
        // ⚠️ DEUX ANGLES MORTS CONNUS, et assumés faute de meilleur signal dans le HTML publié :
        //   * deux VRAIES journées le même soir (un rattrapage) sont classées prévisionnelles,
        //     donc coupées de toute notification — l'équipe ne serait pas convoquée ;
        //   * une SEULE journée non planifiée ne produit aucune signature, donc passe pour
        //     confirmée — l'équipe serait convoquée sur une date bouchon.
        // Dans les deux cas le rattrapage est le même et il est à portée de main : l'admin
        // corrige `dateConfirmed` sur la rencontre (`PATCH /api/interclub/{id}`). C'est
        // pourquoi ce champ est modifiable à la main — et pourquoi CETTE DÉDUCTION NE VAUT QUE
        // POUR UNE RENCONTRE QU'ON DÉCOUVRE : sur une rencontre déjà en base, elle est
        // rapportée (`CalendarDiff.confirmDrift`) et jamais réappliquée, sans quoi le premier
        // « Appliquer » venu révoquerait la correction humaine.
        dateConfirmed: (roundsByDate.get(t.date)?.size ?? 1) === 1,
      };
    });
}

// --- Réseau ----------------------------------------------------------------

/**
 * Le calendrier a bien été REÇU, mais on n'a pas su le lire.
 *
 * Distincte de la panne réseau, parce qu'elle appelle une autre réaction : l'une se réessaie,
 * l'autre demande de recapturer la fixture et de reprendre le parsing. Les confondre enverrait
 * chercher la panne du côté de la fédération, où il n'y a rien à trouver.
 */
export class CalendarUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarUnreadableError";
  }
}

/**
 * Télécharge et parse le calendrier d'UNE POULE. Jette si squashnet ne répond pas — les
 * appelants (import admin, contrôle hebdomadaire) décident quoi en faire, l'un en le disant à
 * l'écran, l'autre en réessayant la semaine suivante.
 *
 * ⚠️ `roundId` DÉSIGNE LA POULE, ET IL N'EST PAS FACULTATIF EN PRATIQUE. Une épreuve fédérale
 * en contient plusieurs (« Hommes 4 - Poule A », « Hommes 4 - Poule IVD »…), et sans lui le
 * site rend celle qu'il veut. Mesuré sur notre propre critérium : sans `roundid`, la réponse
 * était la poule de Jeu de Paume, Montmartre, PUC et Vincennes — où l'Yvette ne figure pas.
 * L'import rapportait donc zéro rencontre, sans erreur et sans explication, ce qui est la pire
 * forme de panne. Il se lit dans l'identifiant du tableau de la poule (`round_<id>`) sur la
 * page « Équipes » de l'équipe.
 *
 * Il reste typé nullable parce qu'une équipe peut n'être pas encore ancrée ; l'appel part alors
 * sans, et rend la poule par défaut. C'est aux routes d'exiger l'ancrage complet — QUATRE
 * identifiants depuis que le classement existe, dont ce module n'utilise que les deux premiers.
 */
export async function fetchTeamCalendar(
  eventId: string,
  roundId: string | null = null,
): Promise<CalendarTie[]> {
  const html = await postAjax({
    ic_a: CALENDAR_ACTION,
    mustache: "1",
    ic_ajax: "1",
    eventid: eventId,
    ...(roundId ? { roundid: roundId } : {}),
  });
  const ties = parseTeamCalendar(html);
  // « LA POULE EST VIDE » ET « ON NE SAIT PLUS LIRE » ÉTAIENT INDISCERNABLES, et c'est le
  // second qui coûte cher : zéro rencontre fait classer TOUT le calendrier en « retirée » et
  // annoncer « J01…J05 retirée du calendrier » sur un calendrier intact. Quand le fragment
  // montre des journées datables mais qu'on n'en tire aucune rencontre, ce n'est pas un
  // calendrier vide — c'est notre lecture qui est périmée, et cela se dit.
  if (ties.length === 0 && dayHeadings(html) > 0) {
    throw new CalendarUnreadableError(
      "Le calendrier a été reçu mais n'a pas pu être lu : le rendu de squashnet a changé.",
    );
  }
  return ties;
}

/** Le fragment est-il un calendrier ? Compté sur les en-têtes de journée réellement datables. */
function dayHeadings(html: string): number {
  return [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].filter((m) => parseDayHeading(m[1]))
    .length;
}

// --- Écart entre ce qu'on a et ce que la fédération publie ------------------

/** Ce qu'on connaît déjà d'une rencontre, côté base. */
export interface StoredTie {
  id: string;
  round: string | null;
  date: string;
  time: string | null;
  home: boolean;
  opponent: string;
  venue: string | null;
  venueAddress: string | null;
  dateConfirmed: boolean;
  /** NULL = saisie à la main, donc intouchable par l'import. */
  snMatchKey: string | null;
}

/** Un champ qui diffère, dans les deux versions, pour l'afficher avant d'écrire. */
export interface FieldChange {
  field: "date" | "time" | "home" | "opponent" | "venue" | "venueAddress";
  from: string | null;
  to: string | null;
}

export interface CalendarDiff {
  /** Journées publiées qu'on n'a pas encore. */
  toCreate: OwnTie[];
  /** Journées connues dont un champ a bougé. */
  toUpdate: { id: string; tie: OwnTie; changes: FieldChange[] }[];
  /**
   * Journées qu'on a IMPORTÉES DE CET ÉVÉNEMENT et que la ligue ne publie plus.
   *
   * Sans cette liste, une journée retirée du calendrier restait en base pour toujours, et le
   * cron quotidien ouvrait consciencieusement son appel de disponibilité pour une rencontre
   * qui n'existe plus. On la SIGNALE ; on ne la supprime jamais d'office — une rencontre peut
   * déjà porter une composition et des réponses, et un scraping qui casse rendrait « plus rien
   * n'est publié » sans que ce soit vrai.
   */
  toDelete: { id: string; round: string | null; date: string; opponent: string }[];
  /**
   * Journées dont le STATUT DE LA DATE diverge — signalées, JAMAIS appliquées.
   *
   * `dateConfirmed` n'est pas un champ publié : c'est une DÉDUCTION (plusieurs journées le même
   * jour = date bouchon), et l'en-tête de ce module reconnaît ses deux angles morts. Le
   * rattrapage prévu est humain : l'admin corrige la rencontre au `PATCH`. Réappliquer la
   * déduction par-dessus cette correction la révoquait sans un mot — l'équipe cessait d'être
   * convoquée pour une rencontre réelle, ou l'était pour une date bouchon.
   *
   * On rapporte donc l'écart au lieu de l'écrire : la déduction informe, elle ne tranche plus.
   */
  confirmDrift: {
    id: string;
    round: string;
    /** Ce que dit la base — la correction humaine, si elle a eu lieu. */
    stored: boolean;
    /** Ce que la déduction lit du calendrier publié aujourd'hui. */
    published: boolean;
  }[];
  /** Journées identiques des deux côtés — comptées, pour dire « rien n'a bougé ». */
  unchanged: number;
}

/** La clé d'ancrage d'une rencontre importée : l'événement et la journée. */
export function matchKey(eventId: string, round: string): string {
  return `${eventId}:${round}`;
}

const asText = (v: string | boolean | null): string | null =>
  v === null ? null : typeof v === "boolean" ? String(v) : v;

/**
 * L'écart entre les rencontres en base et le calendrier publié, rapproché PAR JOURNÉE et non
 * par date : la date est précisément ce qui bouge, donc rapprocher par elle créerait une
 * rencontre de plus à chaque report au lieu de corriger l'existante.
 *
 * Une rencontre SAISIE À LA MAIN (`snMatchKey` nul) n'est jamais proposée à la modification,
 * même si sa journée coïncide : c'est la même doctrine que les corrections de classement, où
 * l'automatique et l'humain ne partagent aucune colonne. Elle n'empêche pas non plus la
 * création de son homologue importée — deux rencontres apparaîtront, et c'est à un humain de
 * trancher, plutôt qu'à un rapprochement approximatif d'en écraser une.
 *
 * Une seule définition de « ce qui a changé », partagée par la prévisualisation, l'application
 * et le contrôle hebdomadaire : deux définitions finiraient par se contredire, et l'alerte
 * annoncerait un écart que l'écran ne montrerait pas.
 */
export function diffCalendar(stored: StoredTie[], fetched: OwnTie[], eventId: string): CalendarDiff {
  const byKey = new Map(
    stored.filter((s) => s.snMatchKey !== null).map((s) => [s.snMatchKey as string, s]),
  );
  const diff: CalendarDiff = { toCreate: [], toUpdate: [], toDelete: [], confirmDrift: [], unchanged: 0 };
  const publies = new Set(fetched.map((t) => matchKey(eventId, t.round)));

  // Ce qu'on a importé DE CET ÉVÉNEMENT et qui n'y figure plus. Le préfixe est vérifié : les
  // rencontres importées d'une AUTRE saison portent une clé d'un autre événement et n'ont rien
  // à voir avec ce qui se publie aujourd'hui — les compter comme disparues signalerait chaque
  // année tout le calendrier de la précédente.
  for (const s of stored) {
    if (s.snMatchKey === null || !s.snMatchKey.startsWith(`${eventId}:`)) continue;
    if (publies.has(s.snMatchKey)) continue;
    diff.toDelete.push({ id: s.id, round: s.round, date: s.date, opponent: s.opponent });
  }

  for (const tie of fetched) {
    const known = byKey.get(matchKey(eventId, tie.round));
    if (!known) {
      diff.toCreate.push(tie);
      continue;
    }
    const changes: FieldChange[] = [];
    const compare = (field: FieldChange["field"], from: string | boolean | null, to: string | boolean | null) => {
      if (asText(from) !== asText(to)) changes.push({ field, from: asText(from), to: asText(to) });
    };
    compare("date", known.date, tie.date);
    compare("time", known.time, tie.time);
    compare("home", known.home, tie.home);
    compare("opponent", known.opponent, tie.opponent);
    compare("venue", known.venue, tie.venue);
    compare("venueAddress", known.venueAddress, tie.venueAddress);
    // `dateConfirmed` N'EST PAS COMPARÉ ICI, et c'est délibéré : il ne rejoint pas `changes`,
    // donc l'application ne le réécrit jamais (cf. `confirmDrift`). Le comparer le rendait
    // « à corriger » comme les autres, et l'`apply` révoquait la correction de l'admin.
    if (known.dateConfirmed !== tie.dateConfirmed) {
      diff.confirmDrift.push({
        id: known.id,
        round: tie.round,
        stored: known.dateConfirmed,
        published: tie.dateConfirmed,
      });
    }
    if (changes.length) diff.toUpdate.push({ id: known.id, tie, changes });
    else diff.unchanged++;
  }
  return diff;
}

/** « confirmée » / « prévisionnelle » — un booléen brut ne dit rien à personne. */
const statutDate = (v: boolean) => (v ? "confirmée" : "prévisionnelle");

/**
 * Résumé lisible d'un écart, pour l'écran comme pour la notification.
 *
 * ⚠️ ELLE VIT ICI, ET PAS DANS LA ROUTE QUI S'EN SERT. Un fichier `route.ts` d'App Router
 * n'accepte QUE des exports connus — les verbes HTTP et une poignée d'options de segment. Y
 * exporter une fonction utilitaire compile en local (`tsc` ne connaît pas cette règle, elle est
 * propre au framework) mais casse `next build` : « describeDiff is not a valid Route export
 * field ». Le déploiement est le premier endroit qui l'apprend, ce qui est le pire endroit.
 */
export function describeDiff(diff: CalendarDiff): string[] {
  return [
    ...diff.toCreate.map((t) => `${t.round} à créer (${t.date})`),
    ...diff.toUpdate.map(
      (u) => `${u.tie.round} : ${u.changes.map((c) => `${c.field} ${c.from ?? "—"} → ${c.to ?? "—"}`).join(", ")}`,
    ),
    ...diff.toDelete.map((d) => `${d.round ?? "?"} n'est plus publiée (${d.date} c. ${d.opponent})`),
    // Dit comme un CONSTAT, pas comme une action : rien ne sera écrit, et la phrase doit le
    // faire comprendre sans qu'on ait à connaître le code.
    ...diff.confirmDrift.map(
      (c) =>
        `${c.round} : la ligue la publie ${statutDate(c.published)}, la base la dit ` +
        `${statutDate(c.stored)} — à corriger à la main si besoin`,
    ),
  ];
}

/**
 * Empreinte du calendrier publié pour une équipe.
 *
 * Elle répond à UNE question, et une seule : « est-ce le même calendrier que la dernière fois
 * qu'on a appliqué ? ». Égale ⇒ le contrôle hebdomadaire se tait sans avoir à reconstruire
 * l'écart complet.
 *
 * ⚠️ Elle ne fait PAS taire une alerte déjà émise : le cron ne la réécrit pas, seule
 * l'application le fait. Un écart non appliqué est donc re-signalé chaque semaine, à dessein —
 * un report enterré dans une notification que personne n'a ouverte serait pire qu'une relance.
 *
 * Elle ne couvre que ce qui, en changeant, mérite de réveiller quelqu'un — pas l'ordre des
 * lignes, qui n'est pas garanti, ni l'adresse postale du club hôte.
 *
 * ⚠️ LE STATUT DE LA DATE EN FAIT PARTIE, bien qu'il ne soit pas publié mais déduit. Sans lui,
 * une journée qui redevenait ferme côté fédération — l'autre journée de sa date replanifiée
 * ailleurs — ne changeait AUCUN champ de l'empreinte : le contrôle hebdomadaire se taisait, la
 * base gardait « prévisionnelle », et l'équipe n'était jamais convoquée pour une rencontre bien
 * réelle. Deux calendriers ne différant que par ce statut rendaient la même empreinte, alors
 * que c'est exactement l'écart qu'il faut faire remonter à un humain.
 */
export function calendarFingerprint(ties: OwnTie[]): string {
  return ties
    .map((t) =>
      [t.round, t.date, t.time ?? "", t.home ? "H" : "A", t.opponent, t.venue ?? "", t.dateConfirmed ? "C" : "P"].join("|"),
    )
    .sort()
    .join("\n");
}
