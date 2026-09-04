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
//   1. LE PARAMÈTRE `teamid` NE FILTRE RIEN. On reçoit l'événement ENTIER (une
//      quinzaine de journées, quatre rencontres chacune). C'est donc à nous de
//      retenir les lignes où notre équipe figure — d'où `ownFixtures`.
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

/** Retire les balises et normalise les espaces. `<br>` devient une espace, pas rien. */
function stripTags(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
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
 */
export function parseDayHeading(text: string): { round: string; date: string } | null {
  const m = /^\s*(\S+)\s*-\s*\S+\s+(\d{1,2})\s+([^\s]+)\s+(\d{4})\s*$/.exec(stripTags(text));
  if (!m) return null;
  const [, round, day, monthWord, year] = m;
  const month = MONTHS[monthWord.toLowerCase()];
  if (!month) return null;
  return { round, date: `${year}-${month}-${day.padStart(2, "0")}` };
}

/** Contenu texte du premier élément portant cette classe, ou « » s'il n'y en a pas. */
function classText(html: string, cls: string): string {
  const m = new RegExp(`class=['"][^'"]*\\b${cls}\\b[^'"]*['"][^>]*>([\\s\\S]*?)</`).exec(html);
  return m ? stripTags(m[1]) : "";
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
  const days = html.split(/<div class=['"]b-day['"]>/).slice(1);
  for (const day of days) {
    const heading = /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(day);
    const parsed = heading ? parseDayHeading(heading[1]) : null;
    if (!parsed) continue;

    for (const row of day.split(/<div class=['"]row['"]>/).slice(1)) {
      const time = /^\d{2}:\d{2}$/.test(classText(row, "time")) ? classText(row, "time") : null;
      for (const match of row.split(/<div class=['"]match['"]>/).slice(1)) {
        // Les deux équipes sont les deux seuls liens porteurs d'un `data-teamid`, dans
        // l'ordre domicile puis extérieur — c'est ce que le rendu garantit, et c'est la seule
        // chose qui distingue « on reçoit » de « on se déplace ».
        const teams = [...match.matchAll(/data-teamid=['"](\d+)['"][^>]*>([\s\S]*?)<\/a>/g)];
        if (teams.length < 2) continue;
        // Le club hôte est le seul `<p>` de la rencontre qui ne contienne pas de lien : les
        // autres enveloppent les noms d'équipe. Chercher « le 3e <p> » marcherait aujourd'hui
        // et casserait au premier <p> ajouté.
        const plainP = [...match.matchAll(/<p class=['"]mb-0['"]>([\s\S]*?)<\/p>/g)]
          .map((m) => m[1])
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
 * La détection du bouchon se fait sur l'événement ENTIER, avant filtrage : c'est là que la
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
        // pourquoi ce champ est modifiable à la main et non déduit à chaque lecture.
        dateConfirmed: (roundsByDate.get(t.date)?.size ?? 1) === 1,
      };
    });
}

// --- Réseau ----------------------------------------------------------------

/**
 * Télécharge et parse le calendrier d'un événement. Jette si squashnet ne répond pas — les
 * appelants (import admin, contrôle hebdomadaire) décident quoi en faire, l'un en le disant à
 * l'écran, l'autre en réessayant la semaine suivante.
 */
export async function fetchTeamCalendar(eventId: string): Promise<CalendarTie[]> {
  const html = await postAjax({
    ic_a: CALENDAR_ACTION,
    mustache: "1",
    ic_ajax: "1",
    eventid: eventId,
  });
  return parseTeamCalendar(html);
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
  field: "date" | "time" | "home" | "opponent" | "venue" | "venueAddress" | "dateConfirmed";
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
  const diff: CalendarDiff = { toCreate: [], toUpdate: [], toDelete: [], unchanged: 0 };
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
    compare("dateConfirmed", known.dateConfirmed, tie.dateConfirmed);
    if (changes.length) diff.toUpdate.push({ id: known.id, tie, changes });
    else diff.unchanged++;
  }
  return diff;
}

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
 */
export function calendarFingerprint(ties: OwnTie[]): string {
  return ties
    .map((t) => [t.round, t.date, t.time ?? "", t.home ? "H" : "A", t.opponent, t.venue ?? ""].join("|"))
    .sort()
    .join("\n");
}
