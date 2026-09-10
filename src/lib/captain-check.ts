import {
  describeSequenceProblem,
  sequenceWinner,
  winGamesFor,
  UNSET_PLAYER,
  type GameScore,
  type Side,
} from "./interclub";
import { classifyRanking, normalize, type MemberIdentity } from "./squashnet/match";
import type { RankingRow } from "./squashnet/client";

// ============================================================================
//  LA VÉRIFICATION D'UNE RENCONTRE, AVANT SAISIE OFFICIELLE — PURE et testée.
//
//  Ce que le capitaine vient chercher ici tient en une phrase : « qu'est-ce qui
//  va coincer quand j'ouvrirai squashnet ? ». Deux familles de réponses, et
//  elles n'ont pas le même coût :
//
//   * LES NOMS. Le formulaire fédéral veut les joueurs tels que la FÉDÉRATION
//     les orthographie. Ce dépôt sait déjà que les deux divergent — il porte
//     deux colonnes pour le réparer (`User.squashnetGivenName`), et un
//     commentaire qui raconte un rapprochement qui échouait « en silence, mois
//     après mois ». Un nom introuvable se découvre sinon devant le formulaire,
//     un dimanche soir, sans personne à qui demander.
//   * LES SCORES. Un simple dont la suite de jeux ne désigne pas de vainqueur,
//     une rencontre dont les simples ne totalisent pas le bon compte : autant
//     d'anomalies qui bloquent la saisie, et qui se corrigent en trente secondes
//     DANS l'appli si on les connaît avant.
//
//  RIEN N'EST RÉÉCRIT ICI DE CE QUI EXISTE. Le contrôle des jeux appartient à
//  `interclub.ts` (`describeSequenceProblem`, `sequenceWinner`), le
//  rapprochement fédéral à `squashnet/match.ts` (`classifyRanking`). Ce module
//  les ASSEMBLE et les traduit en une checklist ; il ne redécide de rien. Deux
//  règles de score écrites à deux endroits divergeraient, et c'est l'écran de
//  vérification qui finirait par mentir sur ce que l'autre accepte.
//
//  AUCUN APPEL RÉSEAU, AUCUN ACCÈS BASE : les lignes fédérales arrivent déjà
//  téléchargées. C'est ce qui rend tout ce fichier testable sans fixture HTTP.
// ============================================================================

/** Ce qu'on a conclu sur un joueur. Repris tel quel de `classifyRanking` — trois verdicts. */
export type PlayerVerdict =
  /** Une seule ligne du club attendu porte ce nom : la saisie passera. */
  | "found"
  /** Le nom existe chez la fédération, mais dans un AUTRE club que celui attendu. */
  | "other-club"
  /** Introuvable, ou plusieurs lignes également plausibles. C'est là qu'on agit. */
  | "unknown";

/** Un joueur de la rencontre, et ce que la fédération en dit. */
export interface PlayerCheck {
  /** Le simple concerné (1..matchCount). */
  order: number;
  side: Side;
  /** Le nom tel qu'il est saisi dans l'appli. */
  name: string;
  verdict: PlayerVerdict;
  /** Le nom tel que la FÉDÉRATION l'écrit — c'est celui à recopier dans le formulaire. */
  fedName: string | null;
  clt: string | null;
  licence: string | null;
  club: string | null;
  /** Quoi faire, en clair. Null quand il n'y a rien à faire. */
  hint: string | null;
}

/** Un simple, et ce qui cloche dans son score. */
export interface ScoreCheck {
  order: number;
  ok: boolean;
  /** Le problème, dans les mots de `interclub.ts`. Null si tout va bien. */
  problem: string | null;
  gamesHome: number;
  gamesAway: number;
  winner: Side | null;
}

/** Le compte de la rencontre, une fois les simples additionnés. */
export interface TieCheck {
  ok: boolean;
  home: number;
  away: number;
  /** Simples sans vainqueur — ils ne comptent pour personne, et il faut le dire. */
  undecided: number;
  problem: string | null;
}

/** Le rapport complet, tel qu'il est stocké et affiché. */
export interface CheckReport {
  /** Horodatage ISO de la vérification. */
  checkedAt: string;
  players: PlayerCheck[];
  scores: ScoreCheck[];
  tie: TieCheck;
}

/** Ce qu'un simple apporte à la vérification. Volontairement minimal. */
export interface MatchInput {
  order: number;
  homeDisplayName: string;
  awayName: string;
  bestOf: number;
  games: GameScore[];
}

// --- Les noms -------------------------------------------------------------

/**
 * L'identité à retrouver chez la fédération, à partir d'un nom affiché.
 *
 * Même approximation que `defaultIdentity` dans `squashnet/refresh.ts`, et c'est VOULU : les
 * deux doivent conclure pareil. Si la vérification annonçait « trouvé » là où le
 * rafraîchissement mensuel échoue (ou l'inverse), le capitaine ne saurait plus lequel croire.
 *
 * Le nom entier part en `familyName` : `classifyRanking` exige que TOUS les jetons se retrouvent
 * dans la ligne, donc cela revient à comparer l'identité complète — ni plus ni moins strict que
 * de la couper en deux, mais sans avoir à deviner où la couper.
 */
export function identityOf(name: string): MemberIdentity {
  return { givenName: "", familyName: name.trim() };
}

/** Le terme envoyé à squashnet : le dernier mot, le plus discriminant en général. */
export function queryOf(name: string): string {
  const tokens = name.trim().split(/\s+/);
  return tokens[tokens.length - 1] ?? "";
}

/**
 * Le remède, écrit pour quelqu'un qui va devoir agir — pas un code d'erreur.
 *
 * Le cas « introuvable » a deux causes très inégales en fréquence, et les nommer dans l'ordre
 * évite de chercher au mauvais endroit : l'orthographe divergente d'abord (c'est la panne que ce
 * dépôt documente déjà), le joueur non licencié ensuite.
 */
function hintFor(verdict: PlayerVerdict, side: Side, club: string | null): string | null {
  if (verdict === "found") return null;
  if (verdict === "other-club") {
    return side === "home"
      ? `La fédération le rattache à ${club ?? "un autre club"}. Si sa mutation n'est pas` +
          ` enregistrée, la saisie sera refusée — à voir avec la ligue.`
      : `Rattaché à ${club ?? "un autre club"} chez la fédération : vérifie le nom du club adverse.`;
  }
  return side === "home"
    ? "Introuvable chez la fédération. Le plus souvent : l'orthographe diffère de ResaMania —" +
        " un admin peut la corriger pour la recherche (nom fédéral du membre). Sinon, joueur" +
        " pas encore licencié."
    : "Introuvable dans le club adverse. Vérifie l'orthographe relevée sur la feuille de match ;" +
        " il peut aussi s'agir d'un joueur muté ou non licencié.";
}

/**
 * Le verdict d'UN joueur, à partir des lignes déjà téléchargées pour son nom.
 *
 * `club` est le club ATTENDU : le nôtre pour un joueur de l'asso, celui de l'adversaire pour un
 * joueur d'en face. C'est le paramètre qui existait déjà dans la signature de `classifyRanking`
 * sans que personne s'en serve — il est fait pour ça.
 *
 * ⚠️ UN NOM NON RENSEIGNÉ N'EST PAS UN NOM INTROUVABLE. Un simple « à désigner » (`UNSET_PLAYER`)
 * ou une case vide n'a rien à chercher chez la fédération : le classer « introuvable » noierait
 * les vrais problèmes sous des lignes rouges que personne ne peut résoudre.
 */
export function checkPlayer(
  order: number,
  side: Side,
  name: string,
  rows: RankingRow[],
  club: string,
): PlayerCheck {
  const nu = { order, side, name, fedName: null, clt: null, licence: null, club: null };
  if (!name.trim() || name.trim() === UNSET_PLAYER) {
    return {
      ...nu,
      verdict: "unknown",
      hint: "Aucun joueur n'est désigné sur ce simple : la rencontre ne peut pas être saisie ainsi.",
    };
  }

  const v = classifyRanking(identityOf(name), rows, { club });
  if (v.status === "matched") {
    return {
      order,
      side,
      name,
      verdict: "found",
      fedName: v.match.name,
      clt: v.match.clt,
      licence: v.match.licence,
      club: v.match.club,
      hint: null,
    };
  }

  // `moved` = le nom est retrouvé, mais hors du club visé. On rend le club où la fédération le
  // place : c'est l'information qui permet de comprendre, et `classifyRanking` ne la porte pas
  // dans ce verdict — on la relit donc dans les lignes.
  if (v.status === "moved") {
    const ailleurs = rows.find((r) => normalize(r.club) !== normalize(club));
    return {
      order,
      side,
      name,
      verdict: "other-club",
      fedName: ailleurs?.name ?? null,
      clt: ailleurs?.clt ?? null,
      licence: ailleurs?.licence ?? null,
      club: ailleurs?.club ?? null,
      hint: hintFor("other-club", side, ailleurs?.club ?? null),
    };
  }

  return { ...nu, verdict: "unknown", hint: hintFor("unknown", side, null) };
}

// --- Les scores -----------------------------------------------------------

/**
 * Le score d'UN simple. Tout le jugement vient de `interclub.ts` : on ne fait que le reformuler.
 *
 * `describeSequenceProblem` rend déjà une phrase lisible (« Jeu 3 : score impossible… »), écrite
 * pour l'écran de saisie. La réutiliser telle quelle garantit que la vérification et la saisie
 * disent LA MÊME CHOSE du même score — deux formulations divergeraient un jour, et c'est le
 * capitaine qui arbitrerait entre deux messages contradictoires.
 */
export function checkScore(m: MatchInput): ScoreCheck {
  const probleme = describeSequenceProblem(m.games, m.bestOf);
  const winner = sequenceWinner(m.games, m.bestOf);
  let home = 0;
  let away = 0;
  for (const g of m.games) {
    if (g.home > g.away) home += 1;
    else if (g.away > g.home) away += 1;
  }
  // Un score valide qui ne désigne pas de vainqueur est un match INACHEVÉ, pas un match faux :
  // c'est un autre problème, et il mérite sa propre phrase plutôt que le silence.
  const inacheve =
    probleme === null && winner === null
      ? `Aucun vainqueur : il faut ${winGamesFor(m.bestOf)} jeux gagnants.`
      : null;
  return {
    order: m.order,
    ok: probleme === null && winner !== null,
    problem: probleme ?? inacheve,
    gamesHome: home,
    gamesAway: away,
    winner,
  };
}

/**
 * Le compte de la rencontre : combien de simples chaque camp a gagnés.
 *
 * On additionne les VAINQUEURS de simples, pas les jeux — c'est ce que la fédération enregistre.
 * Un simple sans vainqueur ne compte pour personne et se dit à part : sans cela, une rencontre à
 * quatre simples dont un est inachevé s'afficherait « 2-1 » et aurait l'air d'un score complet.
 */
export function checkTie(scores: ScoreCheck[], matchCount: number): TieCheck {
  let home = 0;
  let away = 0;
  let undecided = 0;
  for (const s of scores) {
    if (s.winner === "home") home += 1;
    else if (s.winner === "away") away += 1;
    else undecided += 1;
  }
  const manquants = matchCount - scores.length;
  const problem =
    manquants > 0
      ? `${manquants} simple(s) manquant(s) sur les ${matchCount} de la rencontre.`
      : undecided > 0
        ? `${undecided} simple(s) sans vainqueur : la rencontre est incomplète.`
        : null;
  return { ok: problem === null, home, away, undecided, problem };
}

// --- Le rapport -----------------------------------------------------------

/** Combien de points bloquants — c'est le chiffre que porte le bouton et le bandeau. */
export function countProblems(r: CheckReport): number {
  return (
    r.players.filter((p) => p.verdict !== "found").length +
    r.scores.filter((s) => !s.ok).length +
    (r.tie.ok ? 0 : 1)
  );
}

/**
 * Ce JSON a-t-il la forme d'un rapport ?
 *
 * Le rapport est stocké en TEXTE et relu des semaines plus tard par un écran qui lit
 * `r.tie.home` sans garde, et qui n'a pas d'error boundary pour rattraper quoi que ce soit.
 * « JSON valide » ne suffit donc pas : un rapport d'un FORMAT ANTÉRIEUR passe `JSON.parse`,
 * passe un `typeof === "object"`, et lève au rendu.
 *
 * Même garde, et même raison, que `estLigneClassement` dans `squashnet/standings.ts` — on
 * vérifie ce que l'écran LIT, pas davantage.
 */
export function estRapportValide(v: unknown): v is CheckReport {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  const tie = r.tie as Record<string, unknown> | undefined;
  return (
    typeof r.checkedAt === "string" &&
    Array.isArray(r.players) &&
    Array.isArray(r.scores) &&
    typeof tie === "object" &&
    tie !== null &&
    typeof tie.home === "number" &&
    typeof tie.away === "number" &&
    typeof tie.ok === "boolean"
  );
}

/** Relit un rapport stocké, ou `null` si sa forme n'est plus celle qu'on sait afficher. */
export function lireRapport(json: string | null): CheckReport | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    return estRapportValide(v) ? v : null;
  } catch {
    return null;
  }
}
