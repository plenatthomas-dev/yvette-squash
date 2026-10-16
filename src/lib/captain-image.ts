// La feuille d'une rencontre d'interclub, dessinée en IMAGE pour le groupe WhatsApp de l'équipe.
//
// Ce que l'écran capitaine montre, sans ce qui ne sert qu'à la saisie fédérale (licences,
// classements, remèdes) : le compte de la rencontre, puis chaque simple — ses deux joueurs, le
// détail jeu par jeu et les jeux gagnés. L'écran avait été resserré pour tenir dans UNE capture
// de téléphone ; l'image dispense de la capture, et de son recadrage.
//
// Même procédé que le score d'un match libre (`score-image.ts`, dont elle reprend l'en-tête et la
// palette) : canvas 2D, SYNCHRONE, pour que `navigator.share` parte dans la foulée du geste.

import type { CheckReport, PlayerCheck, ScoreCheck } from "@/lib/captain-check";
import {
  CARD_WIDTH,
  CARTE,
  ENCRE,
  FILET,
  FONT,
  HEAD_H,
  PAD,
  PAGE,
  SOURDINE,
  drawHeader,
  fitText,
  roundRect,
  slug,
} from "@/lib/score-image";

export interface RencontrePartagee {
  /** Notre équipe, du nom que la ligue lui donne de préférence (« Yvette 1 »). */
  nous: string;
  eux: string;
  /** Recevons-nous ? */
  home: boolean;
  /** `AAAA-MM-JJ`. */
  date: string;
  round: string | null;
  rapport: CheckReport;
}

const TIE_ROW = 110;
const SIMPLE_ROW = 80;
const SIMPLE_GAP = 20;
const INNER = 40;

/**
 * « DUPONT JEAN-PIERRE » → « Dupont Jean-Pierre ». La fédération écrit en capitales : lisible
 * dans un formulaire, criard dans une conversation, et 15 % plus large à corps égal.
 */
export const enClair = (s: string) =>
  s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());

/** Le nom d'un joueur : celui de la fédération s'il a été rapproché, sinon celui saisi ici. */
const nomDe = (p: PlayerCheck | undefined) => (!p ? "—" : p.fedName ? enClair(p.fedName) : p.name);

const jourLong = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

/** Le verdict en toutes lettres, du point de vue de personne : l'image circule. */
export function verdictRencontre(r: RencontrePartagee): string {
  const { home: h, away: a, undecided } = r.rapport.tie;
  if (undecided > 0) return `Rencontre en cours : ${h}-${a}`;
  if (h > a) return `🏆 ${r.nous} gagne ${h}-${a}`;
  if (a > h) return `🏆 ${r.eux} gagne ${a}-${h}`;
  return `Match nul ${h}-${a}`;
}

/** Les joueurs d'un simple, nous d'abord. */
function joueurs(r: CheckReport, order: number) {
  const du = r.players.filter((p) => p.order === order);
  return [du.find((p) => p.side === "home"), du.find((p) => p.side === "away")] as const;
}

/** Repli sans canvas : la même feuille, en texte. */
export function rencontreTexte(r: RencontrePartagee): string {
  const entete = `${r.nous} ${r.rapport.tie.home}-${r.rapport.tie.away} ${r.eux}`;
  const lignes = r.rapport.scores.map((s) => {
    const [nous, eux] = joueurs(r.rapport, s.order);
    const jeux = s.games.map((g) => `${g.home}-${g.away}`).join(" ");
    return `${s.order}. ${nomDe(nous)} – ${nomDe(eux)} : ${jeux || `${s.gamesHome}-${s.gamesAway}`}`;
  });
  return [entete, ...lignes].join("\n");
}

/** « rencontre-yvette-1-verrieres-3-2026-10-16.png ». */
export function rencontreFileName(r: RencontrePartagee): string {
  return `rencontre-${slug(r.nous, "nous")}-${slug(r.eux, "eux")}-${r.date}.png`;
}

/** La carte arrondie commune au compte et aux simples. */
function carte(ctx: CanvasRenderingContext2D, y: number, h: number) {
  roundRect(ctx, PAD, y, CARD_WIDTH - PAD * 2, h, 28);
  ctx.fillStyle = CARTE;
  ctx.fill();
  ctx.strokeStyle = FILET;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function filet(ctx: CanvasRenderingContext2D, x1: number, x2: number, y: number) {
  ctx.strokeStyle = FILET;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
}

/**
 * Dessine la feuille. `null` sans canvas 2D (vieux navigateur, environnement de test) :
 * l'appelant retombe sur le texte. `logo` : déjà CHARGÉ, ou l'en-tête s'en passe.
 */
export function renderRencontreCard(
  r: RencontrePartagee,
  logo?: HTMLImageElement | null,
): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext?.("2d");
  if (!ctx) return null;

  const { tie, scores } = r.rapport;
  const cardX = PAD;
  const cardW = CARD_WIDTH - PAD * 2;
  const droite = cardX + cardW - INNER;

  const tieY = PAD + HEAD_H + 40;
  const tieH = TIE_ROW * 2 + 32;
  const simplesY = tieY + tieH + 40;
  const simpleH = SIMPLE_ROW * 2 + 24;
  const simplesFin = simplesY + scores.length * (simpleH + SIMPLE_GAP) - SIMPLE_GAP;
  const H = simplesFin + 72 + PAD + 8;
  canvas.width = CARD_WIDTH;
  canvas.height = H;

  ctx.fillStyle = PAGE;
  ctx.fillRect(0, 0, CARD_WIDTH, H);

  // --- en-tête ----------------------------------------------------------------------------------
  const lieu = r.home ? "à domicile" : "à l'extérieur";
  drawHeader(ctx, [r.round, jourLong(r.date), lieu].filter(Boolean).join(" · "), logo);

  // --- le compte de la rencontre : deux lignes, comme le tableau de marque d'un match ----------
  carte(ctx, tieY, tieH);
  const decidee = tie.undecided === 0;
  (
    [
      [r.nous, tie.home, tie.away],
      [r.eux, tie.away, tie.home],
    ] as const
  ).forEach(([nom, pour, contre], i) => {
    const top = tieY + 16 + i * TIE_ROW;
    const mid = top + TIE_ROW / 2;
    if (i === 1) filet(ctx, cardX + INNER, droite, top);
    const gagne = decidee && pour > contre;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = ENCRE;
    ctx.font = `${gagne ? 700 : 400} 54px ${FONT}`;
    ctx.fillText(fitText(ctx, nom, cardW - INNER * 2 - 120), cardX + INNER, mid);
    ctx.textAlign = "right";
    ctx.font = `800 80px ${FONT}`;
    ctx.fillText(String(pour), droite, mid);
  });

  // --- les simples ------------------------------------------------------------------------------
  // Les colonnes de jeux sont ALIGNÉES d'un simple à l'autre : on les cale sur le simple le plus
  // long, pour que les « 11 » se lisent en colonne sur toute la feuille.
  const gameW = 58;
  const wonW = 70;
  const maxJeux = Math.max(1, ...scores.map((s) => s.games.length));
  const gamesX = droite - wonW - maxJeux * gameW;
  const numX = cardX + INNER + 14;
  const nameX = cardX + INNER + 60;
  const nameMax = gamesX - nameX - 20;

  scores.forEach((s: ScoreCheck, k) => {
    const y = simplesY + k * (simpleH + SIMPLE_GAP);
    carte(ctx, y, simpleH);

    // Le numéro du simple, à cheval sur les deux lignes.
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillStyle = SOURDINE;
    ctx.font = `700 36px ${FONT}`;
    ctx.fillText(String(s.order), numX, y + simpleH / 2);

    const duo = joueurs(r.rapport, s.order);
    ([0, 1] as const).forEach((i) => {
      const top = y + 12 + i * SIMPLE_ROW;
      const mid = top + SIMPLE_ROW / 2;
      if (i === 1) filet(ctx, nameX, droite, top);
      const cote = i === 0 ? "home" : "away";
      const gagne = s.winner === cote;

      ctx.textAlign = "left";
      ctx.fillStyle = ENCRE;
      ctx.font = `${gagne ? 700 : 400} 38px ${FONT}`;
      ctx.fillText(fitText(ctx, nomDe(duo[i]), nameMax), nameX, mid);

      // Jeu gagné en encre pleine, jeu perdu en sourdine — comme sur le score d'un match.
      ctx.textAlign = "center";
      s.games.forEach((g, j) => {
        const pour = i === 0 ? g.home : g.away;
        const contre = i === 0 ? g.away : g.home;
        const pris = pour > contre;
        ctx.fillStyle = pris ? ENCRE : SOURDINE;
        ctx.font = `${pris ? 700 : 400} 34px ${FONT}`;
        ctx.fillText(String(pour), gamesX + j * gameW + gameW / 2, mid);
      });

      ctx.textAlign = "right";
      ctx.fillStyle = gagne || s.winner === null ? ENCRE : SOURDINE;
      ctx.font = `800 56px ${FONT}`;
      ctx.fillText(String(i === 0 ? s.gamesHome : s.gamesAway), droite, mid);
    });
  });

  // --- pied : le verdict en toutes lettres ------------------------------------------------------
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = ENCRE;
  ctx.font = `600 40px ${FONT}`;
  ctx.fillText(fitText(ctx, verdictRencontre(r), cardW), PAD, simplesFin + 72);

  return canvas;
}
