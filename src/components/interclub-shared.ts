// Types et constante partagés par l'écran Interclub et son éditeur de simple (sorti de
// Interclub.tsx — audit 2026-10, point 28 : le fichier dépassait 2 400 lignes).

export type RosterEntry = {
  kind: "member" | "guest";
  id: string;
  name: string;
  /** Classement fédéral effectif, ou `null` si inconnu — décide de l'ordre des simples. */
  clt: string | null;
  /**
   * Rang national MIXTE effectif, ou `null` si inconnu. SECOND critère de l'ordre des simples :
   * il départage deux joueurs de même classement (le plus petit rang joue le simple le plus
   * petit), et n'est donc plus un simple confort d'affichage — un joueur non-`NC` qui n'en a
   * pas n'est alignable nulle part. Un `NC` en est dispensé : la fédération ne les ordonne pas
   * entre eux (cf. `interclub-order.ts`).
   */
  rangM: number | null;
};

export type MatchRow = {
  id: string;
  order: number;
  homeUserId: string | null;
  /** Renseigné à la place de `homeUserId` quand le joueur aligné n'a pas de compte. */
  homeGuestId: string | null;
  homeDisplayName: string;
  awayName: string;
  homeColor: string | null;
  awayColor: string | null;
  status: string;
  gamesHome: number | null;
  gamesAway: number | null;
  games: { number: number; home: number; away: number }[];
  scorerId: string | null;
  scorerName: string | null;
  isMine: boolean;
  scorerStale: boolean;
  /** Premier point et point décisif, posés par le marquage en direct. ISO, `null` si inconnus. */
  startedAt: string | null;
  finishedAt: string | null;
  /** Révision du marquage (cf. `PUT …/live`). */
  liveRev?: number;
  /** Forfait / abandon, et le côté qui l'emporte. Absents ou `null` : match joué. */
  outcome?: "forfait" | "abandon" | null;
  outcomeWinner?: "home" | "away" | null;
  /** Instantané du jeu en cours, publié par le marqueur. `null` hors direct. */
  live: {
    current: { home: number; away: number };
    serving: "home" | "away" | null;
    servingBox: "right" | "left" | null;
    awaitingServeBox: boolean;
  } | null;
};

/**
 * La valeur d'option qui ROUVRE la saisie libre, dans les deux menus (club adverse, adversaire).
 *
 * Une chaîne qu'aucun nom réel ne peut porter — un club ne s'appelle pas « \u0000autre ». Un
 * sentinelle lisible (« __autre__ », « autre ») finirait un jour par désigner quelqu'un, et ce
 * jour-là le menu se rouvrirait tout seul en effaçant le nom choisi, sans qu'on comprenne
 * pourquoi.
 */
export const AUTRE_CLUB = "\u0000autre";
