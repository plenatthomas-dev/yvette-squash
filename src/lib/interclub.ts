// Moteur de comptage d'un match de squash (interclub). Module PUR : aucun import de prisma
// ni de next/server, pour rester utilisable côté client (l'écran marqueur compte hors-ligne)
// et testable sans base — même contrat que `tricount.ts` et `tournament.ts`.
//
// Règles WSF/PSA en vigueur :
//  * PAR 11 — chaque échange donne un point, quel que soit le serveur ;
//  * un jeu se gagne à 11 points avec 2 points d'ÉCART (10-10 → prolongation 12, 13…) ;
//  * le match se joue au meilleur des 3 ou 5 jeux selon la division.
//
// Le SERVICE est la partie subtile, et la source de la plupart des erreurs de marquage :
//  * le serveur qui GAGNE l'échange garde le service et CHANGE de carré automatiquement ;
//  * le joueur qui REPREND le service CHOISIT son carré — l'appli doit donc le demander,
//    on ne peut pas le déduire ;
//  * en début de jeu, le premier serveur choisit aussi son carré.
// D'où `awaitingServeBox` : tant qu'il est vrai, l'écran doit réclamer le carré avant
// d'accepter le point suivant.
//
// Tout l'état se DÉRIVE d'un journal d'événements (`replay`). L'undo est donc un simple
// `pop()` suivi d'un rejeu : un seul chemin de code, aucune divergence possible entre ce que
// l'écran affiche et ce que le journal dit.

export type Side = "home" | "away";
export type Box = "right" | "left";

/** Un jeu se gagne à 11 points… */
export const POINTS_TO_WIN = 11;
/** …mais toujours avec 2 points d'écart (10-10 → 12-10, 13-11, …). */
export const MIN_LEAD = 2;
/**
 * Pause réglementaire entre deux jeux, en secondes.
 *
 * 2 min depuis les règles WSF du 1er septembre 2025, qui alignent le squash amateur sur la
 * PSA (c'était 1 min 30 auparavant). Cf. l'annonce de la FFSquash, « Nouvelles règles du jeu
 * du squash en simple 2025 » : échauffement 4 min, 1 min avant le début du match, 2 min
 * entre les jeux.
 */
export const BREAK_SECONDS = 120;
/** Échauffement d'avant-match, en secondes (4 min depuis les règles 2025 — cf. ci-dessus). */
export const WARMUP_SECONDS = 240;
/** Formats de match admis : au meilleur des 3 ou des 5 jeux. */
export const BEST_OF_VALUES = [3, 5] as const;
/** Bornes du nombre de simples dans une rencontre. */
export const MIN_MATCH_COUNT = 1;
export const MAX_MATCH_COUNT = 8;

export type ScoreEvent =
  // Un échange gagné par `side`.
  | { t: "point"; side: Side }
  // Prise de service : qui sert et de quel carré. Redondant à dessein (le côté pourrait se
  // déduire), pour que le journal soit auto-descriptif et rejouable isolément.
  | { t: "serve"; side: Side; box: Box };

export interface GameScore {
  home: number;
  away: number;
}

export interface MatchState {
  /** Jeux TERMINÉS, dans l'ordre. */
  games: GameScore[];
  /** Jeu en cours (0-0 si le match n'a pas commencé ou vient de se terminer). */
  current: GameScore;
  /** Nombre de jeux gagnés de chaque côté. */
  gamesWon: GameScore;
  /** Qui sert. `null` tant que le premier serveur n'a pas été désigné. */
  serving: Side | null;
  /** De quel carré. `null` quand le choix est attendu. */
  servingBox: Box | null;
  /** Vrai ⇒ l'écran doit réclamer le carré avant d'accepter le point suivant. */
  awaitingServeBox: boolean;
  status: "pending" | "live" | "done";
  winner: Side | null;
}

/** Nombre de jeux à gagner pour remporter le match (3 → 2 ; 5 → 3). */
export function winGamesFor(bestOf: number): number {
  return Math.floor(bestOf / 2) + 1;
}

/** L'autre côté. */
export function other(side: Side): Side {
  return side === "home" ? "away" : "home";
}

/** Le vainqueur d'un jeu, ou `null` s'il n'est pas fini (11 points ET 2 d'écart). */
export function gameWinner(g: GameScore): Side | null {
  const { home, away } = g;
  const lead = Math.abs(home - away);
  if (Math.max(home, away) < POINTS_TO_WIN || lead < MIN_LEAD) return null;
  return home > away ? "home" : "away";
}

/** Un score de jeu TERMINÉ est-il plausible ? Sert à valider une saisie a posteriori. */
export function validGameScore(a: number, b: number): boolean {
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
  if (a < 0 || b < 0) return false;
  return gameWinner({ home: a, away: b }) !== null;
}

/**
 * Une suite de jeux saisie a posteriori est-elle cohérente ? Chaque jeu doit être terminé, et
 * surtout AUCUN jeu ne doit suivre la fin du match — un « 3-0 » suivi d'un 4e jeu est une
 * faute de frappe, pas un score.
 */
export function validGameSequence(games: readonly GameScore[], bestOf: number): boolean {
  if (games.length === 0) return true; // match pas encore joué : c'est valide
  if (games.length > bestOf) return false;
  const needed = winGamesFor(bestOf);
  let home = 0;
  let away = 0;
  for (const g of games) {
    if (home >= needed || away >= needed) return false; // le match était déjà fini
    // `checkGame` plutôt que `gameWinner` : lui seul écarte un 12-0, qui satisfait pourtant
    // « 11 points et 2 d'écart ». Le serveur applique ainsi exactement la règle que l'écran
    // de saisie affiche.
    if (checkGame(g) !== "finished") return false;
    if (gameWinner(g) === "home") home += 1;
    else away += 1;
  }
  return true;
}

/**
 * État d'un jeu en cours de SAISIE. Distinguer « pas encore fini » d'« impossible » est
 * essentiel : une ligne fraîchement ajoutée vaut 0-0, ce qui n'est pas une erreur mais un
 * jeu qu'on n'a pas encore renseigné. Crier à l'erreur dès l'ouverture apprend à l'utilisateur
 * à ignorer les messages.
 */
export type GameCheck = "empty" | "in-progress" | "finished" | "impossible";

export function checkGame(g: GameScore): GameCheck {
  const { home, away } = g;
  if (!Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0) return "impossible";
  if (home === 0 && away === 0) return "empty";
  // L'impossible se teste AVANT le terminé : un 12-0 satisfait « 11 points et 2 d'écart »,
  // mais au-delà de 11 on ne marque que pour prendre 2 points d'écart — il n'a pas pu exister.
  if (Math.max(home, away) > POINTS_TO_WIN && Math.abs(home - away) > MIN_LEAD) return "impossible";
  if (gameWinner(g)) return "finished";
  return "in-progress";
}

/**
 * Décrit le premier problème d'une suite de jeux en cours de saisie, ou `null` si tout va bien.
 * Les jeux vides (0-0) sont ignorés : ce sont des lignes qu'on vient d'ouvrir. Le message est
 * volontairement précis — « le jeu 2 n'est pas terminé » vaut mieux qu'un rappel du règlement.
 */
export function describeSequenceProblem(games: readonly GameScore[], bestOf: number): string | null {
  if (games.length > bestOf) return `Un match au meilleur des ${bestOf} jeux n'en compte pas plus de ${bestOf}.`;

  const needed = winGamesFor(bestOf);
  let home = 0;
  let away = 0;

  for (let i = 0; i < games.length; i++) {
    const state = checkGame(games[i]);
    if (state === "empty") continue;
    if (state === "impossible") {
      return `Jeu ${i + 1} : score impossible. Un jeu se gagne à 11 points, et au-delà seul un écart de 2 points le conclut.`;
    }
    if (state === "in-progress") {
      return `Jeu ${i + 1} : pas encore terminé (11 points, avec 2 points d'écart).`;
    }
    if (home >= needed || away >= needed) {
      return `Le match était déjà gagné avant le jeu ${i + 1}.`;
    }
    if (gameWinner(games[i]) === "home") home += 1;
    else away += 1;
  }

  return null;
}

/** Les jeux réellement joués, dans l'ordre — les lignes vides sont écartées. */
export function playedGames(games: readonly GameScore[]): GameScore[] {
  return games.filter((g) => checkGame(g) === "finished");
}

/** La suite de jeux désigne-t-elle un vainqueur du match ? */
export function sequenceWinner(games: readonly GameScore[], bestOf: number): Side | null {
  const needed = winGamesFor(bestOf);
  let home = 0;
  let away = 0;
  for (const g of games) {
    const w = gameWinner(g);
    if (w === "home") home += 1;
    else if (w === "away") away += 1;
  }
  if (home >= needed) return "home";
  if (away >= needed) return "away";
  return null;
}

export function isValidBestOf(n: unknown): n is 3 | 5 {
  return (BEST_OF_VALUES as readonly number[]).includes(n as number);
}

export function isValidMatchCount(n: unknown): boolean {
  return Number.isInteger(n) && (n as number) >= MIN_MATCH_COUNT && (n as number) <= MAX_MATCH_COUNT;
}

function emptyState(): MatchState {
  return {
    games: [],
    current: { home: 0, away: 0 },
    gamesWon: { home: 0, away: 0 },
    serving: null,
    servingBox: null,
    awaitingServeBox: false,
    status: "pending",
    winner: null,
  };
}

/**
 * Rejoue un journal d'événements et renvoie l'état résultant. Fonction TOTALE : elle ne jette
 * jamais et ignore les événements qui n'ont pas de sens dans l'état courant (point après la
 * fin du match, service désigné alors qu'aucun n'est attendu). Un journal tronqué par un undo
 * reste donc rejouable tel quel.
 */
export function replay(events: readonly ScoreEvent[], bestOf: number): MatchState {
  const needed = winGamesFor(bestOf);
  const s = emptyState();

  for (const e of events) {
    if (s.status === "done") break;

    if (e.t === "serve") {
      s.serving = e.side;
      s.servingBox = e.box;
      s.awaitingServeBox = false;
      continue;
    }

    // Un point avant même que le premier serveur soit désigné n'a pas de sens : l'écran ne
    // le propose pas. On l'ignore plutôt que de deviner un serveur.
    if (s.serving === null) continue;

    s.status = "live";
    if (e.side === "home") s.current.home += 1;
    else s.current.away += 1;

    const winnerOfGame = gameWinner(s.current);
    if (winnerOfGame) {
      s.games.push({ ...s.current });
      if (winnerOfGame === "home") s.gamesWon.home += 1;
      else s.gamesWon.away += 1;
      s.current = { home: 0, away: 0 };

      if (s.gamesWon.home >= needed || s.gamesWon.away >= needed) {
        s.status = "done";
        s.winner = s.gamesWon.home > s.gamesWon.away ? "home" : "away";
        s.serving = null;
        s.servingBox = null;
        s.awaitingServeBox = false;
        continue;
      }

      // Jeu suivant : le vainqueur du jeu sert en premier, et choisit son carré.
      s.serving = winnerOfGame;
      s.servingBox = null;
      s.awaitingServeBox = true;
      continue;
    }

    if (e.side === s.serving) {
      // Le serveur marque : il garde le service et change de carré.
      s.servingBox = s.servingBox === "right" ? "left" : "right";
    } else {
      // Reprise de service : le nouveau serveur choisit son carré.
      s.serving = e.side;
      s.servingBox = null;
      s.awaitingServeBox = true;
    }
  }

  return s;
}

/** Ajoute un point au journal, si l'état l'autorise. Renvoie le journal (inchangé si refusé). */
export function applyPoint(
  events: readonly ScoreEvent[],
  bestOf: number,
  side: Side,
): ScoreEvent[] {
  const s = replay(events, bestOf);
  if (s.status === "done" || s.serving === null || s.awaitingServeBox) return [...events];
  return [...events, { t: "point", side }];
}

/** Désigne le serveur et son carré. Renvoie le journal (inchangé si le match est fini). */
export function applyServe(
  events: readonly ScoreEvent[],
  bestOf: number,
  side: Side,
  box: Box,
): ScoreEvent[] {
  const s = replay(events, bestOf);
  if (s.status === "done") return [...events];
  return [...events, { t: "serve", side, box }];
}

/** Annule le dernier événement. C'est la fonction la plus utilisée d'un écran de marquage. */
export function undo(events: readonly ScoreEvent[]): ScoreEvent[] {
  return events.slice(0, -1);
}

export function isMatchOver(state: MatchState): boolean {
  return state.status === "done";
}

/**
 * Fabrique un journal d'événements qui REPRODUIT une suite de jeux déjà connue. Sert à
 * reprendre au bord du terrain un match dont les premiers jeux ont été saisis à la main, ou
 * dont le journal local a été perdu (autre téléphone, cache vidé).
 *
 * ⚠️ Le déroulé des échanges est INVENTÉ — seul le score de chaque jeu est fidèle. C'est
 * assumé : on ne stocke pas les points un par un, donc il n'y a rien à restituer. Les points
 * sont émis en alternance jusqu'au score du perdant, puis d'affilée pour le vainqueur, de
 * sorte que chaque jeu se termine exactement sur son dernier point et pas avant.
 */
export function seedEvents(games: readonly GameScore[], bestOf: number): ScoreEvent[] {
  let ev: ScoreEvent[] = applyServe([], bestOf, "home", "right");

  const point = (side: Side) => {
    const st = replay(ev, bestOf);
    if (st.awaitingServeBox && st.serving) ev = applyServe(ev, bestOf, st.serving, "right");
    ev = applyPoint(ev, bestOf, side);
  };

  for (const g of games) {
    if (checkGame(g) !== "finished") continue;
    const lo = Math.min(g.home, g.away);
    const winner: Side = g.home > g.away ? "home" : "away";
    for (let i = 0; i < lo; i++) {
      point(winner);
      point(other(winner));
    }
    const remaining = Math.max(g.home, g.away) - lo;
    for (let i = 0; i < remaining; i++) point(winner);
  }

  return ev;
}

// --- Couleurs de joueur ----------------------------------------------------
// Pour reconnaître les joueurs depuis le bord du terrain (« Jérôme joue en rouge »). La
// couleur est LIBRE (n'importe quel #rrggbb) : un maillot ne rentre pas dans huit cases.
//
// DESIGN.md impose pourtant la « Règle de la Paire Complète » — une couleur hors thème n'est
// acceptable que si elle fixe le fond ET l'encre. On ne stocke donc que le fond, et l'encre
// est CALCULÉE : blanc ou noir, celui des deux qui contraste le mieux.
//
// Sur l'encre PLEINE, ce choix tient le seuil AA quelle que soit la couleur : le pire cas du
// cube RGB atteint 4.58:1, au-dessus des 4.5 requis (le test le vérifie en balayant le cube).
//
// ⚠️ CE QUE CE MODULE NE PEUT PAS GARANTIR — et ce commentaire l'a affirmé à tort. La borne
// ci-dessus ne vaut que si l'encre est rendue TELLE QUELLE. `.ics-won` et `.ics-serve`
// (globals.css) la repeignent à `opacity: .85` sur le maillot : le pire cas du cube retombe
// alors à 3.51:1, et quatre des douze raccourcis de couleur passent sous 4.5 (rose 3.89,
// vert 4.21, turquoise 4.36, rouge 4.43). Le test continue de passer — il mesure une couleur
// qui n'est jamais celle qu'on voit. Écart CONNU ET ASSUMÉ à ce jour ; ce qu'il faut retenir,
// c'est que toute opacité posée sur cette encre défait le calcul, et que le test ne le dira pas.
//
// ⚠️ La couleur s'applique en PASTILLE ou en grande zone TACTILE (les deux demi-écrans du
// marqueur, cf. `.ics-side`), jamais en aplat décoratif : DESIGN.md réserve les grandes
// surfaces colorées à ce qui est actionnable.

export const INK_LIGHT = "#ffffff";
export const INK_DARK = "#000000";

/** Raccourcis proposés avant d'ouvrir le sélecteur libre — les maillots les plus courants. */
export const COLOR_PRESETS: readonly { key: string; label: string; hex: string }[] = [
  { key: "rouge", label: "Rouge", hex: "#c62828" },
  { key: "bleu", label: "Bleu", hex: "#1565c0" },
  { key: "vert", label: "Vert", hex: "#2e7d32" },
  { key: "jaune", label: "Jaune", hex: "#fdd835" },
  { key: "orange", label: "Orange", hex: "#f57c00" },
  { key: "violet", label: "Violet", hex: "#6a1b9a" },
  { key: "rose", label: "Rose", hex: "#d81b60" },
  { key: "turquoise", label: "Turquoise", hex: "#00897b" },
  { key: "gris", label: "Gris", hex: "#616161" },
  { key: "noir", label: "Noir", hex: "#212121" },
  { key: "blanc", label: "Blanc", hex: "#f5f5f5" },
  { key: "marine", label: "Marine", hex: "#1a237e" },
] as const;

/** Luminance relative WCAG d'une couleur `#rrggbb`. */
export function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** Rapport de contraste WCAG entre deux couleurs `#rrggbb` (1 → 21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** L'encre à poser sur `bg` : blanc ou noir, le plus lisible des deux. */
export function inkFor(bg: string): string {
  return contrastRatio(bg, INK_LIGHT) >= contrastRatio(bg, INK_DARK) ? INK_LIGHT : INK_DARK;
}

/**
 * Ramène une valeur reçue (client ou base) à un `#rrggbb` minuscule, ou `null`.
 * Accepte aussi les clés de l'ancienne palette fermée (« rouge », « bleu »…) : des lignes
 * saisies avant le passage au choix libre les portent encore.
 */
export function normalizeColor(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const raw = v.trim();
  if (!raw) return null;
  const hex = /^#?([0-9a-f]{6})$/i.exec(raw);
  if (hex) return `#${hex[1].toLowerCase()}`;
  const preset = COLOR_PRESETS.find((c) => c.key === raw.toLowerCase());
  return preset ? preset.hex : null;
}

/** Garde de type pour une couleur reçue d'un client. `null` = pas de couleur, c'est valide. */
export function isColorValue(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return true;
  return normalizeColor(v) !== null;
}

export interface ResolvedColor {
  /** Fond de la pastille. */
  bg: string;
  /** Encre calculée, jamais stockée : la paire reste cohérente quoi qu'il arrive en base. */
  fg: string;
  label: string;
}

/** Résout une couleur en paire fond/encre prête à peindre, ou `null` si absente. */
export function resolveColor(v: unknown): ResolvedColor | null {
  const bg = normalizeColor(v);
  if (!bg) return null;
  const preset = COLOR_PRESETS.find((c) => c.hex === bg);
  return { bg, fg: inkFor(bg), label: preset ? preset.label : bg };
}

/**
 * Distance PERCEPTUELLE entre deux couleurs (CIE76, ΔE sur L*a*b*).
 *
 * Le choix libre a un coût que la palette fermée n'avait pas : deux joueurs peuvent choisir
 * deux bleus voisins, et les pastilles cessent alors de distinguer quoi que ce soit — ce pour
 * quoi elles existent. Une distance euclidienne en RGB ne dirait rien d'utile ici (elle traite
 * un écart dans le bleu comme un écart dans le vert, alors que l'œil ne le fait pas) ; L*a*b*
 * est conçu pour que la distance corresponde à peu près à la différence perçue.
 */
function labOf(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  // sRGB → XYZ (D65), normalisé par le blanc de référence.
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function colorDistance(a: string, b: string): number {
  const [l1, a1, b1] = labOf(a);
  const [l2, a2, b2] = labOf(b);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

/**
 * Seuil en deçà duquel deux maillots se confondent d'un coup d'œil.
 *
 * Calibré sur les raccourcis : la paire la plus proche de la palette curée — violet et marine —
 * est à ΔE ≈ 25,8, et elle a été jugée distinguable. Deux bleus voisins (#1565c0 / #1976d2)
 * tombent à 7,1. Le seuil sépare donc bien les deux familles, sans prétendre à plus de
 * précision qu'un repère : c'est un avertissement, pas une science.
 */
export const MIN_DISTINCT_DELTA_E = 25;

/**
 * Les deux maillots d'un match risquent-ils d'être confondus ? Une couleur absente ne déclenche
 * rien : ne pas choisir est un choix valide, et deux pastilles dont une seule existe se
 * distinguent très bien.
 */
export function colorsTooClose(a: unknown, b: unknown): boolean {
  const ca = normalizeColor(a);
  const cb = normalizeColor(b);
  if (!ca || !cb) return false;
  return colorDistance(ca, cb) < MIN_DISTINCT_DELTA_E;
}

// --- Abonnements -----------------------------------------------------------
// Niveau d'abonnement au suivi d'une équipe. Le dosage est le vrai sujet : une notification
// par échange, c'est ~200 par match et ~800 par soirée — personne ne garde ça activé une
// semaine. D'où trois paliers, et l'absence d'abonnement comme défaut.

export const FOLLOW_LEVELS = ["result", "highlights", "detailed"] as const;
export type FollowLevel = (typeof FOLLOW_LEVELS)[number];

export const FOLLOW_LABELS: Record<FollowLevel, string> = {
  result: "Résultat final seulement",
  highlights: "Temps forts (début, matchs gagnés, résultat)",
  detailed: "Détaillé (chaque jeu terminé)",
};

export function isFollowLevel(v: unknown): v is FollowLevel {
  return typeof v === "string" && (FOLLOW_LEVELS as readonly string[]).includes(v);
}

/** Lit un niveau venu d'une source non fiable. `null` = pas d'abonnement. */
export function parseFollowLevel(v: unknown): FollowLevel | null {
  return isFollowLevel(v) ? v : null;
}

/** Un abonné au niveau `have` doit-il être prévenu d'un événement de niveau `want` ? */
export function notifiesAt(have: FollowLevel, want: FollowLevel): boolean {
  return FOLLOW_LEVELS.indexOf(have) >= FOLLOW_LEVELS.indexOf(want);
}
