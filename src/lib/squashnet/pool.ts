import { postAjax } from "./client";
import { estEquipeFictive } from "./fictive";
import { TR, cellules, dateIso, entier, heure, texte, txt, valeur, type Cellule } from "./html";
import { STANDINGS_ACTION, parseStandings, type StandingRow } from "./standings";
import { gagnant, joueur, type TiePlayer } from "./tie";

// ============================================================================
//  LES RENCONTRES D'UNE POULE (squashnet.fr), PUBLIQUES.
//
//  Le fragment du classement (`ic_a=394242`, cf. `standings.ts`) ne s'arrête pas
//  au tableau : il publie ensuite TOUTES les rencontres de la poule, chacune avec
//  ses simples, ses joueurs et le score jeu par jeu. Mesuré le 2026-10-18 sur la
//  poule B des Hommes 4 : 247 Ko, 110 rencontres. On les jetait — elles donnent
//  pourtant, SANS UNE REQUÊTE DE PLUS, les résultats de n'importe quelle équipe
//  de la poule et le détail de chacune de ses soirées.
//
//  UN BLOC PAR RENCONTRE : `<table id="table_tie_N">` puis, quand elle est jouée,
//  `<div class="tie-score">` (les deux noms complets et le total).
//
//  ⚠️ LES INTITULÉS DE COLONNES SONT DES DONNÉES, comme sur la feuille de match
//  (`tie.ts`). L'en-tête d'un bloc s'écrit `J1 · 08-10-2026 20:00 · VERR5 ·
//  AQISSY · Score · …` : la journée, la date et les deux SIGLES. Les cellules
//  portent ces mêmes intitulés en `data-label`. On lit donc l'en-tête pour savoir
//  QUEL intitulé joue QUEL rôle — c'est la seule lecture par position, et elle
//  porte sur des libellés qui changent à chaque bloc, donc ne peuvent pas être
//  codés en dur. Les cellules, elles, restent trouvées par leur `data-label`.
//
//  LE RECEVEUR EST À GAUCHE. Mesuré deux fois : VERR5–AQISSY s'est joué à
//  Verrières (adresse de la fiche Squash App), AQISSY–VERR4 à Issy ; et le total
//  du bloc écrit « Squash in Issy 4 - 0 Verrieres 4 » quel que soit le vainqueur.
//
//  ⚠️ UNE RENCONTRE NON JOUÉE PORTE LA CLASSE `winner` DES DEUX CÔTÉS, sur des
//  cases vides. Le vainqueur d'un simple n'est donc retenu que si UN SEUL côté
//  porte la marque — jamais sur la seule présence de la classe.
// ============================================================================

/**
 * Le fragment porte des rencontres qu'on ne sait plus lire.
 *
 * Même doctrine que `TieUnreadableError` : une poule sans rencontre publiée est un FAIT (début
 * de saison), un bloc dont l'en-tête ne s'identifie plus est une PANNE. Les confondre ferait
 * afficher « aucune rencontre » sur une poule qui en a cent dix.
 */
export class PoolUnreadableError extends Error {
  constructor(raison: string) {
    super("rencontres de poule illisibles : " + raison);
    this.name = "PoolUnreadableError";
  }
}

/** Un simple d'une rencontre de poule. */
export interface PoolLine {
  /** Rang du simple dans la rencontre, 1 à 4. */
  order: number | null;
  /** « Homme 1 ». */
  label: string;
  /** Le joueur du RECEVEUR, ou null (simple non saisi). */
  home: TiePlayer | null;
  away: TiePlayer | null;
  /** Le score TEL QUEL, du point de vue du receveur : « 11-4 12-14 11-9 3-11 9-11 ». */
  score: string | null;
  winner: "home" | "away" | null;
}

/** Une rencontre de la poule. */
export interface PoolTie {
  /** La journée, « J1 ». */
  round: string;
  /** « YYYY-MM-DD ». */
  date: string | null;
  /** « HH:MM ». */
  time: string | null;
  /**
   * Faux quand la date est un BOUCHON : la fédération pose la même date sur toutes les journées
   * non planifiées (cf. `calendar.ts`, point 2). Même signature que `ownFixtures` — plusieurs
   * journées le même jour —, cherchée sur la poule ENTIÈRE avant d'écarter les exemptions, avec
   * l'angle mort qu'elle y documente (un vrai soir de rattrapage passerait pour un bouchon).
   * Une seule correction ici : une date où un simple a été JOUÉ n'est jamais un bouchon.
   */
  dateConfirmed: boolean;
  /** Sigle du receveur, « VERR5 » — celui de `StandingRow.code`. */
  homeCode: string;
  awayCode: string;
  /** Noms complets, lus dans le total. Null tant que la rencontre n'est pas jouée. */
  homeName: string | null;
  awayName: string | null;
  /**
   * Simples gagnés par chaque côté, LUS dans le total publié. NULL, et non 0, tant que la ligue
   * n'en publie pas : un « 0-0 » se lirait comme un nul à quatre simples.
   */
  scoreHome: number | null;
  scoreAway: number | null;
  lines: PoolLine[];
}

const TABLE_TIE =/<table[^>]*id=["']table_tie_\d+["'][^>]*>[\s\S]*?<\/table>/gi;
const TH = /<th[^>]*>([\s\S]*?)<\/th>/gi;
const TIE_SCORE =
  /<div[^>]*class=["']tie-score["'][^>]*>\s*<div[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*>([\s\S]*?)<\/div>/i;

/** Les intitulés de l'en-tête d'un bloc, dans l'ordre. */
function entete(table: string): string[] {
  const thead = /<thead[^>]*>([\s\S]*?)<\/thead>/i.exec(table)?.[1] ?? "";
  const out: string[] = [];
  TH.lastIndex = 0;
  let th: RegExpExecArray | null;
  while ((th = TH.exec(thead)) !== null) out.push(texte(th[1]));
  return out;
}

/** Le vainqueur d'un simple : un seul côté marqué, ET un joueur saisi (cf. l'en-tête). */
function vainqueur(
  home: Cellule | undefined,
  away: Cellule | undefined,
  saisi: boolean,
): "home" | "away" | null {
  if (!saisi) return null;
  const h = gagnant(home);
  const a = gagnant(away);
  return h && !a ? "home" : a && !h ? "away" : null;
}

/** Le total du bloc, s'il est publié : [nom receveur, score, nom visiteur]. */
function total(apres: string): { homeName: string; awayName: string; home: number; away: number } | null {
  const m = TIE_SCORE.exec(apres);
  if (!m) return null;
  const s = /^(\d+)\s*-\s*(\d+)$/.exec(texte(m[2]));
  if (!s) return null;
  return {
    homeName: texte(m[1]),
    awayName: texte(m[3]),
    home: Number.parseInt(s[1], 10),
    away: Number.parseInt(s[2], 10),
  };
}

/**
 * Les rencontres de la poule, lues dans le fragment du classement.
 *
 * Les rencontres contre une équipe FICTIVE (« EXEMPT ») sont écartées : elles ne se jouent pas,
 * et la fédération les range toutes à la date bouchon.
 *
 * Jette `PoolUnreadableError` si un bloc n'a pas ses quatre intitulés, ou si ses cellules ne
 * portent pas les sigles de son en-tête. Rend une liste vide s'il n'y a aucun bloc.
 */
export function parsePoolTies(html: string): PoolTie[] {
  const blocs = [...html.matchAll(TABLE_TIE)];
  const brutes: PoolTie[] = [];

  blocs.forEach((m, i) => {
    const table = m[0];
    const [round, quand, homeCode, awayCode, colScore] = entete(table);
    // « Score » en cinquième position est le témoin que les quatre premières sont bien journée,
    // date et sigles : une colonne de moins décalerait tout, et « Score » deviendrait un sigle.
    if (!round || !quand || !homeCode || !awayCode || colScore !== "Score") {
      throw new PoolUnreadableError("en-tête inattendu sur le bloc " + (i + 1));
    }

    const lines: PoolLine[] = [];
    TR.lastIndex = 0;
    let tr: RegExpExecArray | null;
    while ((tr = TR.exec(table)) !== null) {
      const c = cellules(tr[1]);
      if (c.length === 0) continue; // l'en-tête, en <th>

      const home = c.find((x) => x.label === homeCode);
      // Deux sigles identiques : le visiteur est la SECONDE case qui le porte.
      const away = c.find((x) => x.label === awayCode && x !== home);
      if (!home || !away) {
        throw new PoolUnreadableError(`cases ${homeCode} / ${awayCode} introuvables (bloc ${i + 1})`);
      }
      const h = joueur(home);
      const a = joueur(away);
      lines.push({
        order: entier(valeur(c, round)),
        label: valeur(c, quand),
        home: h,
        away: a,
        score: txt(valeur(c, "Score")),
        winner: vainqueur(home, away, h !== null || a !== null),
      });
    }

    // Le total suit la table, AVANT le bloc suivant : le chercher plus loin attribuerait à une
    // rencontre non jouée le score de la suivante.
    const fin = (m.index ?? 0) + table.length;
    const suivant = blocs[i + 1]?.index ?? html.length;
    const t = total(html.slice(fin, suivant));

    brutes.push({
      round,
      date: dateIso(quand.slice(0, 10)),
      time: heure(quand),
      dateConfirmed: true,
      homeCode,
      awayCode,
      homeName: t?.homeName ?? null,
      awayName: t?.awayName ?? null,
      scoreHome: t?.home ?? null,
      scoreAway: t?.away ?? null,
      lines,
    });
  });

  // La date bouchon, reconnue à sa signature sur la poule entière (exemptions comprises).
  const journeesParDate = new Map<string, Set<string>>();
  const jouees = new Set<string>();
  for (const t of brutes) {
    if (!t.date) continue;
    const set = journeesParDate.get(t.date) ?? new Set<string>();
    set.add(t.round);
    journeesParDate.set(t.date, set);
    if (t.lines.some((l) => l.winner !== null)) jouees.add(t.date);
  }

  return brutes
    .filter((t) => !estEquipeFictive(t.homeCode) && !estEquipeFictive(t.awayCode))
    .map((t) => ({
      ...t,
      dateConfirmed:
        !t.date || jouees.has(t.date) || (journeesParDate.get(t.date)?.size ?? 0) <= 1,
    }));
}

/** Une poule entière : son classement, et ses rencontres. */
export interface Pool {
  standings: StandingRow[];
  /**
   * Null quand les rencontres sont ILLISIBLES (`PoolUnreadableError`). Le classement, lui, reste
   * servi : un rendu des rencontres qui change ne doit pas emporter le tableau qui s'affiche
   * depuis le début de la saison.
   */
  ties: PoolTie[] | null;
  /** La raison de l'illisibilité, pour le journal ; null sinon. */
  tiesError: string | null;
}

/** Le classement et les rencontres d'un même fragment — cf. `parseStandings`, `parsePoolTies`. */
export function parsePool(html: string): Pool {
  const standings = parseStandings(html);
  try {
    return { standings, ties: parsePoolTies(html), tiesError: null };
  } catch (e) {
    if (!(e instanceof PoolUnreadableError)) throw e;
    return { standings, ties: null, tiesError: e.message };
  }
}

/**
 * Télécharge une poule : classement ET rencontres, en UNE requête.
 *
 * Les trois identifiants sont obligatoires, pour la raison que donne `fetchStandings` : sans
 * `drawId`, la fédération rend la division 1 dans un fragment parfaitement crédible.
 */
export async function fetchPool(eventId: string, drawId: string, roundId: string): Promise<Pool> {
  const html = await postAjax({
    ic_a: STANDINGS_ACTION,
    mustache: "1",
    ic_ajax: "1",
    eventid: eventId,
    drawid: drawId,
    roundid: roundId,
  });
  return parsePool(html);
}
