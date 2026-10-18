import { inverserScore } from "./interclub-score";
import { nomLisible } from "./nom-lisible";
import { normalize } from "./squashnet/match";
import { nameKey } from "./squashnet/roster";
import type { TieLine, TieSheet } from "./squashnet/tie";

// ============================================================================
//  LES STATISTIQUES DE JOUEUR — ce que chacun a fait en interclub.
//
//  TOUT PART DE LA FEUILLE DE MATCH OFFICIELLE, et de rien d'autre. Le palmarès
//  se calculait sur nos propres relevés (`InterclubMatch`) : une soirée que
//  personne n'avait marquée dans l'appli n'existait pas, et les pourcentages de
//  tout le monde en étaient faussés sans que rien ne le dise. La feuille que la
//  ligue publie, elle, couvre toutes les rencontres jouées — c'est sur elle que
//  se fait le classement de poule, c'est donc elle qui fait foi ici aussi.
//  Elle est relue avec ce classement, par les mêmes déclencheurs
//  (`interclub-sheets.ts`).
//
//  Le calcul est PUR et testé ici ; la route ne fait que lire la base et
//  l'appeler.
//
//  QUATRE RÈGLES QUI NE SE DEVINENT PAS À LA LECTURE D'UN RENDU :
//
//   1. UNE FEUILLE DONT NOTRE CÔTÉ EST INCONNU NE COMPTE PAS. La ligue nomme les
//      deux camps « A » et « B » sans dire lequel est le nôtre (cf. `ourSide`).
//      Compter à l'envers attribuerait à nos joueurs les victoires d'en face.
//
//   2. UN SIMPLE NE COMPTE QUE TRANCHÉ. La ligue pose la classe `winner` sur la
//      case du vainqueur ; sans elle, le simple n'est pas encore saisi. Et un
//      simple sans joueur DE NOTRE CÔTÉ (forfait) n'est le palmarès de personne.
//
//   3. ON REGROUPE PAR JOUEUR DE L'APPLI, ET SEULEMENT À DÉFAUT PAR NOM FÉDÉRAL.
//      La feuille ne connaît que « POPULU AXEL ». La licence (via notre fiche
//      d'équipe) le relie à un compte ou à un joueur sans compte ; à défaut, le
//      nom ; et quand rien ne le relie, il garde son nom fédéral plutôt que de
//      disparaître — un joueur parti a quand même joué ses matchs.
//
//   4. LES JEUX ET LES POINTS SONT TUS S'IL EN MANQUE UN SEUL. Un total partiel
//      se lirait comme un total. Même doctrine que le départage d'un nul.
// ============================================================================

export interface StatTally {
  won: number;
  lost: number;
  diff: number;
}

export interface PlayerStatRow {
  /** `u:<id>`, `g:<id>` ou `n:<nom>` — stable d'un appel à l'autre. */
  key: string;
  name: string;
  /** Vrai = membre de l'appli. Faux = joueur sans compte, ou que l'on n'a pas su relier. */
  isMember: boolean;
  played: number;
  won: number;
  lost: number;
  /**
   * Part de victoires, 0 à 1. NULL quand aucun match n'est joué : un pourcentage sur zéro
   * match n'est pas « 0 % », c'est une absence de réponse, et l'écrire 0 % accuserait à tort.
   */
  winRate: number | null;
  /** Jeux. NULL si la ligue ne les publie pas sur au moins un simple (règle 4). */
  games: StatTally | null;
  /** Points de jeu. NULL dans le même cas. */
  rallies: StatTally | null;
  /**
   * SES MATCHS, un par simple compté — du plus récent au plus ancien. Calculés dans la MÊME
   * boucle que les chiffres, sous les mêmes règles : la liste compte toujours `played` lignes,
   * dont `won` gagnées. Une fenêtre qui annoncerait « 7 matchs » sous une ligne « MJ 6 » ferait
   * douter des deux.
   */
  matches: StatMatch[];
}

/** Un match d'un de nos joueurs, tel que la fenêtre du palmarès le raconte. */
export interface StatMatch {
  /** « YYYY-MM-DD » — celle de NOTRE rencontre, à défaut celle de la feuille. */
  date: string | null;
  /** Notre équipe ce soir-là, « Équipe 2 ». */
  teamName: string | null;
  /** L'équipe adverse, telle que la rencontre la nomme chez nous. */
  opponentTeam: string | null;
  /** L'adversaire, « Detry Xavier » — nom fédéral remis en casse lisible. */
  opponentName: string | null;
  /** Son classement ce soir-là, « 5B ». */
  opponentClt: string | null;
  /** L'intitulé fédéral du simple, « Homme 2 ». */
  label: string;
  won: boolean;
  /**
   * Le score DE NOTRE POINT DE VUE : la feuille l'écrit côté A (vérifié sur la fixture de
   * référence, « 9-11 4-11 11-9 7-11 » pour Jeux A 1 – B 3), on le retourne quand nous sommes B.
   */
  score: string | null;
}

/** Sous quelle identité un joueur de la feuille est compté. */
export interface StatIdentity {
  key: string;
  name: string;
  isMember: boolean;
}

/** Une feuille officielle, avec notre côté — ou null quand on ne l'a pas reconnu (règle 1). */
export interface OfficialFixture {
  sheet: TieSheet;
  side: "A" | "B" | null;
  /** La rencontre chez nous : de quoi dater et situer chaque match dans la fenêtre du palmarès. */
  meta?: { date: string | null; teamName: string | null; opponent: string | null };
}

// ---------------------------------------------------------------------------
//  La feuille, relue depuis la base.
// ---------------------------------------------------------------------------

const estEntierOuNul = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v));

function estJoueur(v: unknown): boolean {
  if (v === null) return true;
  return typeof v === "object" && typeof (v as Record<string, unknown>).name === "string";
}

function estLigne(v: unknown): v is TieLine {
  if (typeof v !== "object" || v === null) return false;
  const l = v as Record<string, unknown>;
  return (
    typeof l.label === "string" &&
    estJoueur(l.a) &&
    estJoueur(l.b) &&
    (l.winner === null || l.winner === "A" || l.winner === "B") &&
    estEntierOuNul(l.gamesA) &&
    estEntierOuNul(l.gamesB) &&
    estEntierOuNul(l.pointsA) &&
    estEntierOuNul(l.pointsB)
  );
}

/**
 * La feuille rangée en base, ou null si sa forme n'est pas celle qu'on sait lire.
 *
 * VÉRIFIÉE ET PAS SEULEMENT PARSÉE, comme `lireRoster` : un JSON d'un format antérieur passe
 * `JSON.parse` puis lève au calcul — et c'est tout le palmarès du club qui tomberait avec lui.
 * Une feuille illisible est simplement ignorée, comme une feuille pas encore lue.
 */
export function lireFeuille(json: string | null | undefined): TieSheet | null {
  if (!json) return null;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const s = v as Record<string, unknown>;
  if (typeof s.snTieId !== "string" || !Array.isArray(s.lines)) return null;
  return s.lines.every(estLigne) ? (v as TieSheet) : null;
}

/** Notre côté tel que rangé en base, ou null pour toute autre valeur. */
export function lireCote(v: string | null | undefined): "A" | "B" | null {
  return v === "A" || v === "B" ? v : null;
}

/**
 * La feuille est-elle COMPLÈTE — tous ses simples saisis et tranchés ?
 *
 * C'est ce qui dit s'il faut encore la relire : une feuille complète hors de la fenêtre
 * d'après-match ne bougera plus, une feuille partielle attend la fin de la saisie.
 */
export function feuilleComplete(sheet: TieSheet | null): boolean {
  if (!sheet || sheet.lines.length === 0) return false;
  return sheet.lines.every((l) => (l.a !== null || l.b !== null) && l.winner !== null);
}

/** La feuille porte-t-elle au moins un simple saisi ? Sinon, la ligue n'a encore rien dit. */
export function feuilleSaisie(sheet: TieSheet): boolean {
  return sheet.lines.some((l) => l.a !== null || l.b !== null);
}

// ---------------------------------------------------------------------------
//  Qui est qui : du nom fédéral au joueur de l'appli (règle 3).
// ---------------------------------------------------------------------------

/** Un joueur de l'appli, tel que le rapprochement a besoin de le connaître. */
export interface AppPlayer {
  kind: "member" | "guest";
  id: string;
  /** Le nom affiché dans l'appli — c'est lui qu'on montre. */
  name: string;
  /** La licence rapprochée de notre fiche d'équipe, ou null. */
  licence: string | null;
  /** Les autres noms sous lesquels la fédération peut le connaître (nom de recherche…). */
  altNames?: readonly string[];
}

/** Un inscrit de notre fiche d'équipe fédérale : son nom tel que la feuille l'écrit, sa licence. */
export interface FederalEntry {
  name: string;
  licence: string | null;
}

const cleLicence = (v: string | null | undefined) => (v ?? "").trim().toUpperCase();

export { nomLisible };

/**
 * Le résolveur d'identité : nom fédéral → joueur de l'appli.
 *
 * DEUX CHEMINS, dans cet ordre :
 *
 *  1. LA LICENCE. Notre fiche d'équipe relie le nom fédéral à une licence, la licence à un
 *     joueur (`snLicence`). C'est une preuve : elle ne dépend d'aucune orthographe.
 *  2. LE NOM, ordre des mots indifférent (`nameKey`) — nom affiché, puis noms de recherche.
 *
 * L'AMBIGUÏTÉ NE TRANCHE PAS. Deux joueurs de l'appli derrière la même licence ou le même nom,
 * et on n'en relie aucun : le palmarès d'un homonyme posé sur quelqu'un d'autre, personne ne
 * va le vérifier. Le joueur reste alors compté sous son nom fédéral — juste, simplement moins
 * bien présenté.
 */
export function identityResolver(
  players: readonly AppPlayer[],
  federal: readonly FederalEntry[],
): (fedName: string) => StatIdentity {
  const unique = (paires: ReadonlyArray<readonly [string, AppPlayer]>) => {
    const m = new Map<string, AppPlayer | null>();
    for (const [k, p] of paires) {
      const deja = m.get(k);
      m.set(k, deja === undefined || deja?.id === p.id ? p : null);
    }
    return m;
  };

  const parLicence = unique(
    players.filter((p) => cleLicence(p.licence)).map((p) => [cleLicence(p.licence), p] as const),
  );
  const parNom = unique(
    players.flatMap((p) =>
      [p.name, ...(p.altNames ?? [])]
        .map(nameKey)
        .filter(Boolean)
        .map((k) => [k, p] as const),
    ),
  );
  // Nom fédéral → licence. Deux inscrits de même nom (deux équipes, un homonyme) et des licences
  // différentes : la licence ne dit plus rien, on passe au nom.
  const licenceDe = new Map<string, string | null>();
  for (const f of federal) {
    const k = nameKey(f.name);
    const l = cleLicence(f.licence);
    if (!k || !l) continue;
    const deja = licenceDe.get(k);
    licenceDe.set(k, deja === undefined || deja === l ? l : null);
  }

  return (fedName) => {
    const k = nameKey(fedName);
    const licence = k ? licenceDe.get(k) : null;
    const p = (licence ? parLicence.get(licence) : null) ?? (k ? parNom.get(k) : null) ?? null;
    if (p) {
      return {
        key: (p.kind === "member" ? "u:" : "g:") + p.id,
        name: p.name,
        isMember: p.kind === "member",
      };
    }
    return { key: "n:" + (k || normalize(fedName)), name: nomLisible(fedName), isMember: false };
  };
}

// ---------------------------------------------------------------------------
//  Le palmarès.
// ---------------------------------------------------------------------------

/**
 * Les statistiques de chaque joueur, du plus de victoires au moins.
 *
 * L'ORDRE EST PAR VICTOIRES, PAS PAR POURCENTAGE. Classer au pourcentage mettrait en tête
 * celui qui a gagné son unique match, devant celui qui en a gagné neuf sur douze — un
 * palmarès que personne ne reconnaîtrait comme le sien. Le pourcentage est affiché, il ne
 * classe pas.
 */
export function playerStats(
  fixtures: readonly OfficialFixture[],
  identify: (fedName: string) => StatIdentity,
): PlayerStatRow[] {
  const par = new Map<
    string,
    {
      id: StatIdentity;
      played: number;
      won: number;
      lost: number;
      jeux: StatTally | null;
      points: StatTally | null;
      matchs: StatMatch[];
    }
  >();

  for (const { sheet, side, meta } of fixtures) {
    // Règle 1.
    if (side === null) continue;
    for (const l of sheet.lines) {
      const nous = side === "A" ? l.a : l.b;
      // Règle 2.
      if (!nous || l.winner === null) continue;

      const id = identify(nous.name);
      let ligne = par.get(id.key);
      if (!ligne) {
        ligne = {
          id,
          played: 0,
          won: 0,
          lost: 0,
          jeux: { won: 0, lost: 0, diff: 0 },
          points: { won: 0, lost: 0, diff: 0 },
          matchs: [],
        };
        par.set(id.key, ligne);
      }

      ligne.played += 1;
      if (l.winner === side) ligne.won += 1;
      else ligne.lost += 1;

      // Règle 4 : un seul simple sans jeux ni points, et le total se tait.
      const [jn, je] = side === "A" ? [l.gamesA, l.gamesB] : [l.gamesB, l.gamesA];
      const [pn, pe] = side === "A" ? [l.pointsA, l.pointsB] : [l.pointsB, l.pointsA];
      ligne.jeux = cumule(ligne.jeux, jn, je);
      ligne.points = cumule(ligne.points, pn, pe);

      const eux = side === "A" ? l.b : l.a;
      ligne.matchs.push({
        date: meta?.date ?? sheet.date,
        teamName: meta?.teamName ?? null,
        opponentTeam: meta?.opponent ?? null,
        opponentName: eux ? nomLisible(eux.name) : null,
        opponentClt: eux?.clt ?? null,
        label: l.label,
        won: l.winner === side,
        score: l.score && side === "B" ? inverserScore(l.score) : l.score,
      });
    }
  }

  const lignes: PlayerStatRow[] = [...par.values()].map((l) => ({
    key: l.id.key,
    name: l.id.name,
    isMember: l.id.isMember,
    played: l.played,
    won: l.won,
    lost: l.lost,
    winRate: l.played > 0 ? l.won / l.played : null,
    games: l.jeux,
    rallies: l.points,
    // Du plus récent au plus ancien ; dans une même soirée, dans l'ordre des simples.
    matches: l.matchs
      .map((m, i) => ({ m, i }))
      .sort((a, b) => (b.m.date ?? "").localeCompare(a.m.date ?? "") || a.i - b.i)
      .map(({ m }) => m),
  }));

  lignes.sort(
    (a, b) =>
      b.won - a.won ||
      (b.winRate ?? 0) - (a.winRate ?? 0) ||
      b.played - a.played ||
      a.name.localeCompare(b.name, "fr"),
  );
  return lignes;
}

function cumule(t: StatTally | null, nous: number | null, eux: number | null): StatTally | null {
  if (t === null || nous === null || eux === null) return null;
  const won = t.won + nous;
  const lost = t.lost + eux;
  return { won, lost, diff: won - lost };
}
