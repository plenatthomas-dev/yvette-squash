// ============================================================================
//  LES STATISTIQUES DE JOUEUR — ce que chacun a fait en interclub.
//
//  Tout part des SIMPLES (`InterclubMatch`) et de rien d'autre : c'est la seule
//  table qui sache qui a joué contre qui et avec quel score. Le calcul est PUR
//  et testé ici ; la route ne fait que lire la base et l'appeler.
//
//  TROIS RÈGLES QUI NE SE DEVINENT PAS À LA LECTURE D'UN RENDU :
//
//   1. UN MATCH NE COMPTE QUE TERMINÉ (`status === "done"`). `gamesHome` est
//      renseignée dès le PREMIER jeu joué : s'y fier ferait entrer dans les
//      statistiques un match mené 1-0 en plein milieu de la soirée, et le
//      pourcentage de victoires de tout le monde bougerait pendant qu'on joue.
//
//   2. ON REGROUPE PAR IDENTIFIANT, ET SEULEMENT À DÉFAUT PAR NOM. Un joueur
//      retiré du roster garde ses lignes (`onDelete: SetNull`) mais perd son
//      `homeUserId` ; son nom reste figé dans `homeDisplayName`. Regrouper par
//      nom d'abord fusionnerait deux homonymes ; ne regrouper que par
//      identifiant ferait disparaître l'historique d'un joueur parti. On fait
//      donc les deux, dans cet ordre.
//
//   3. LES POINTS DE JEU SONT TUS SI LE DÉTAIL EST INCOMPLET. Un match saisi
//      « 3-1 » sans son jeu par jeu rendrait un total PARTIEL, qu'on lirait
//      comme un total. Même doctrine que le départage d'un nul.
// ============================================================================

/** Un simple, réduit à ce dont le calcul a besoin. */
export interface StatMatch {
  status: string;
  gamesHome: number | null;
  gamesAway: number | null;
  /** Le membre aligné, ou null (joueur sans compte, ou compte supprimé). */
  homeUserId: string | null;
  /** Le joueur du roster sans compte, ou null. */
  homeGuestId: string | null;
  /** Le nom FIGÉ au moment de la composition. Seul recours quand les deux id manquent. */
  homeDisplayName: string;
  /** Le jeu par jeu, quand il a été saisi. */
  games: { home: number; away: number }[];
}

export interface StatTally {
  won: number;
  lost: number;
  diff: number;
}

export interface PlayerStatRow {
  /** `u:<id>`, `g:<id>` ou `n:<nom>` — stable d'un appel à l'autre. */
  key: string;
  name: string;
  /** Vrai = membre de l'appli. Faux = joueur sans compte, ou compte supprimé. */
  isMember: boolean;
  played: number;
  won: number;
  lost: number;
  /**
   * Part de victoires, 0 à 1. NULL quand aucun match n'est joué : un pourcentage sur zéro
   * match n'est pas « 0 % », c'est une absence de réponse, et l'écrire 0 % accuserait à tort.
   */
  winRate: number | null;
  games: StatTally;
  /** Points de jeu. NULL si le détail manque sur au moins un match. */
  rallies: StatTally | null;
}

/** L'identité sous laquelle un simple est compté. Voir la règle 2 de l'en-tête. */
function identite(m: StatMatch): { key: string; isMember: boolean } {
  if (m.homeUserId) return { key: `u:${m.homeUserId}`, isMember: true };
  if (m.homeGuestId) return { key: `g:${m.homeGuestId}`, isMember: false };
  // Ni l'un ni l'autre : le compte a été supprimé, ou la ligne est plus vieille que le roster.
  // Le nom figé est tout ce qui reste — mieux que de jeter l'historique.
  return { key: `n:${m.homeDisplayName.trim().toLowerCase()}`, isMember: false };
}

/**
 * Les statistiques de chaque joueur, du plus de victoires au moins.
 *
 * L'ORDRE EST PAR VICTOIRES, PAS PAR POURCENTAGE. Classer au pourcentage mettrait en tête
 * celui qui a gagné son unique match, devant celui qui en a gagné neuf sur douze — un
 * palmarès que personne ne reconnaîtrait comme le sien. Le pourcentage est affiché, il ne
 * classe pas.
 */
export function playerStats(matches: StatMatch[]): PlayerStatRow[] {
  const par = new Map<
    string,
    PlayerStatRow & { detailComplet: boolean; ptsGagnes: number; ptsPerdus: number }
  >();

  for (const m of matches) {
    // Règle 1 : seul un match TERMINÉ compte.
    if (m.status !== "done" || m.gamesHome === null || m.gamesAway === null) continue;
    const { key, isMember } = identite(m);
    let ligne = par.get(key);
    if (!ligne) {
      ligne = {
        key,
        name: m.homeDisplayName,
        isMember,
        played: 0,
        won: 0,
        lost: 0,
        winRate: null,
        games: { won: 0, lost: 0, diff: 0 },
        rallies: null,
        detailComplet: true,
        ptsGagnes: 0,
        ptsPerdus: 0,
      };
      par.set(key, ligne);
    }

    ligne.played += 1;
    if (m.gamesHome > m.gamesAway) ligne.won += 1;
    else if (m.gamesAway > m.gamesHome) ligne.lost += 1;
    ligne.games.won += m.gamesHome;
    ligne.games.lost += m.gamesAway;

    // Règle 3 : le nombre de jeux DÉTAILLÉS doit égaler le nombre de jeux joués.
    if (m.games.length !== m.gamesHome + m.gamesAway) {
      ligne.detailComplet = false;
    } else {
      for (const j of m.games) {
        ligne.ptsGagnes += j.home;
        ligne.ptsPerdus += j.away;
      }
    }
  }

  const lignes: PlayerStatRow[] = [];
  for (const l of par.values()) {
    lignes.push({
      key: l.key,
      name: l.name,
      isMember: l.isMember,
      played: l.played,
      won: l.won,
      lost: l.lost,
      winRate: l.played > 0 ? l.won / l.played : null,
      games: { won: l.games.won, lost: l.games.lost, diff: l.games.won - l.games.lost },
      rallies: l.detailComplet
        ? { won: l.ptsGagnes, lost: l.ptsPerdus, diff: l.ptsGagnes - l.ptsPerdus }
        : null,
    });
  }

  lignes.sort(
    (a, b) =>
      b.won - a.won ||
      (b.winRate ?? 0) - (a.winRate ?? 0) ||
      b.played - a.played ||
      a.name.localeCompare(b.name, "fr"),
  );
  return lignes;
}
