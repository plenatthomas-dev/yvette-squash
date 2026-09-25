// Le score d'un match libre, dessiné en IMAGE pour être partagé (WhatsApp, SMS…).
//
// Pourquoi une image et pas le texte : dans un groupe de club, on envoie une capture, pas une
// phrase. Une image se lit d'un coup d'œil dans le fil de discussion, garde la mise en forme
// (noms, points jeu par jeu, jeux gagnés) et porte le logo du club.
//
// Dessin au canvas 2D, sans dépendance : pas de bibliothèque de capture d'écran (html2canvas &
// co. alourdiraient le bundle et devraient composer avec la CSP stricte). Tout est SYNCHRONE —
// `toDataURL` plutôt que `toBlob` — et c'est voulu : `navigator.share` exige que l'appel parte
// dans la foulée du geste de l'utilisateur. Safari iOS retire ce droit si un `await` s'intercale
// trop longtemps ; générer l'image sans attendre le garde intact.

import { summarize, type FreeMatch } from "@/lib/free-scorer";
import { resolveColor } from "@/lib/interclub";

/** Largeur de l'image, en px. 1080 : le format carré/portrait des messageries, net sur tout écran. */
export const CARD_WIDTH = 1080;
const PAD = 64;
const ROW_H = 132;
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// Palette du thème sombre du produit (DESIGN.md) : page, carte, filet, texte, sourdine. L'image
// quitte l'appli, elle ne suit donc pas le thème choisi — le sombre est celui de `theme_color`.
const PAGE = "#0e1116";
const CARTE = "#191e26";
const FILET = "#434b58";
const ENCRE = "#f3f4f6";
const SOURDINE = "#9aa2ae";
// Paire ambre « en cours » (hors thème, documentée dans DESIGN.md).
const LIVE_BG = "#fcd34d";
const LIVE_FG = "#78350f";

/** Texte tronqué à `max` px avec une ellipse, mesuré avec la police courante du contexte. */
export function fitText(ctx: Pick<CanvasRenderingContext2D, "measureText">, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + "…").width > max) s = s.slice(0, -1);
  return s.trimEnd() + "…";
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function prettyDate(ms: number): string {
  return new Date(ms).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
}

/**
 * Dessine la carte de score. `null` si le navigateur n'offre pas de canvas 2D (très vieux
 * navigateur, environnement de test) : l'appelant retombe alors sur le partage en texte.
 *
 * `logo` : le logo du club, déjà CHARGÉ (le dessin est synchrone, il ne l'attend pas). Absent
 * ou pas encore prêt, l'en-tête s'en passe.
 */
export function renderScoreCard(m: FreeMatch, logo?: HTMLImageElement | null): HTMLCanvasElement | null {
  const s = summarize(m);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext?.("2d");
  if (!ctx) return null;

  const headH = 120;
  const cardY = PAD + headH + 40;
  const cardH = ROW_H * 2 + 48;
  const footH = 96;
  const H = cardY + cardH + footH + PAD - 24;
  canvas.width = CARD_WIDTH;
  canvas.height = H;

  ctx.fillStyle = PAGE;
  ctx.fillRect(0, 0, CARD_WIDTH, H);

  // --- en-tête : logo, nom du club, date -------------------------------------------------------
  let textX = PAD;
  if (logo && logo.complete && logo.naturalWidth > 0) {
    const size = headH;
    ctx.save();
    roundRect(ctx, PAD, PAD, size, size, 24);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.clip();
    const ratio = Math.min(size / logo.naturalWidth, size / logo.naturalHeight);
    const w = logo.naturalWidth * ratio;
    const h = logo.naturalHeight * ratio;
    ctx.drawImage(logo, PAD + (size - w) / 2, PAD + (size - h) / 2, w, h);
    ctx.restore();
    textX = PAD + size + 32;
  }
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = ENCRE;
  ctx.font = `700 48px ${FONT}`;
  ctx.fillText("Squash de l'Yvette", textX, PAD + 58);
  ctx.fillStyle = SOURDINE;
  ctx.font = `400 34px ${FONT}`;
  // Les matchs de tournoi entrent dans l'historique sous l'id `trn-<match>` (cf. Tournament).
  const genre = m.id.startsWith("trn-") ? "Tournoi" : "Match amical";
  const sous = `${s.done ? genre : "Match en cours"} · ${prettyDate(m.startedAt)}`;
  ctx.fillText(fitText(ctx, sous, CARD_WIDTH - textX - PAD), textX, PAD + 106);

  // --- tableau de marque ------------------------------------------------------------------------
  const cardX = PAD;
  const cardW = CARD_WIDTH - PAD * 2;
  roundRect(ctx, cardX, cardY, cardW, cardH, 28);
  ctx.fillStyle = CARTE;
  ctx.fill();
  ctx.strokeStyle = FILET;
  ctx.lineWidth = 2;
  ctx.stroke();

  const inner = 40;
  const wonW = 90; // colonne des jeux gagnés
  const gameW = 76; // une colonne par jeu
  const nGames = s.games.length + (s.current ? 1 : 0);
  const gamesX = cardX + cardW - inner - wonW - nGames * gameW;
  const nameX = cardX + inner + 56;
  const nameMax = gamesX - nameX - 24;

  ([s.first, s.second] as const).forEach((side, r) => {
    const top = cardY + 24 + r * ROW_H;
    const mid = top + ROW_H / 2;
    const winner = s.done && r === 0;

    if (r === 1) {
      ctx.strokeStyle = FILET;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cardX + inner, top);
      ctx.lineTo(cardX + cardW - inner, top);
      ctx.stroke();
    }

    // pastille de couleur (cerclée : un maillot noir ou marine reste visible sur la carte)
    const c = resolveColor(m[side].color);
    ctx.beginPath();
    ctx.arc(cardX + inner + 18, mid, 18, 0, Math.PI * 2);
    ctx.fillStyle = c ? c.bg : "transparent";
    ctx.fill();
    ctx.strokeStyle = SOURDINE;
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = ENCRE;
    ctx.font = `${winner ? 700 : 400} 54px ${FONT}`;
    ctx.fillText(fitText(ctx, m[side].name, nameMax), nameX, mid);

    // points jeu par jeu : le jeu gagné en encre pleine, le jeu perdu en sourdine
    ctx.textAlign = "center";
    s.games.forEach((g, i) => {
      const won = g[r] > g[1 - r];
      ctx.fillStyle = won ? ENCRE : SOURDINE;
      ctx.font = `${won ? 700 : 400} 42px ${FONT}`;
      ctx.fillText(String(g[r]), gamesX + i * gameW + gameW / 2, mid);
    });
    if (s.current) {
      const x = gamesX + s.games.length * gameW;
      roundRect(ctx, x + 8, mid - 32, gameW - 16, 64, 12);
      ctx.fillStyle = LIVE_BG;
      ctx.fill();
      ctx.fillStyle = LIVE_FG;
      ctx.font = `700 42px ${FONT}`;
      const pts = s.current[side === "home" ? 0 : 1];
      ctx.fillText(String(pts), x + gameW / 2, mid);
    }

    ctx.textAlign = "right";
    ctx.fillStyle = ENCRE;
    ctx.font = `800 80px ${FONT}`;
    ctx.fillText(String(s.gamesWon[r]), cardX + cardW - inner, mid);
  });

  // --- pied : le verdict en toutes lettres -----------------------------------------------------
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = ENCRE;
  ctx.font = `600 40px ${FONT}`;
  const verdict = s.done
    ? `🏆 ${m[s.first].name} gagne ${s.gamesWon[0]}-${s.gamesWon[1]}`
    : `En cours : ${s.gamesWon[0]}-${s.gamesWon[1]} en jeux`;
  ctx.fillText(fitText(ctx, verdict, CARD_WIDTH - PAD * 2), PAD, cardY + cardH + 72);

  return canvas;
}

/** Canvas → fichier PNG, SYNCHRONE (cf. l'en-tête : le geste de partage ne doit pas expirer). */
export function canvasToPng(canvas: HTMLCanvasElement, name: string): File {
  const url = canvas.toDataURL("image/png");
  const bin = atob(url.slice(url.indexOf(",") + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: "image/png" });
}

/** Nom de fichier lisible : « score-paul-marc-2026-09-25.png ». */
export function scoreFileName(m: FreeMatch): string {
  const slug = (v: string) =>
    v
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 20) || "joueur";
  const d = new Date(m.startedAt);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `score-${slug(m.home.name)}-${slug(m.away.name)}-${iso}.png`;
}
