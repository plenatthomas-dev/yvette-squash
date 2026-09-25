// Marqueur libre : compter un match hors interclub (amical, entraînement, tournoi interne).
//
// TOUT RESTE SUR LE TÉLÉPHONE. Un match amical n'a pas de valeur partagée : personne d'autre
// n'a besoin du score après coup, et le stocker côté serveur créerait de la donnée nominative
// (des noms libres, souvent de non-membres) sans usage. Le partage passe par « Partager le
// résultat », qui envoie un texte là où le joueur le veut. Cf. docs/etude-marqueur-libre.md.
//
// On garde le JOURNAL (`ScoreEvent[]`), jamais le score : l'état se dérive par `replay`, comme
// au marquage d'interclub — l'undo et la reprise après rechargement restent donc exacts.
//
// Préfixe `free:` distinct de `ic:` (InterclubScorer) : un match libre et un simple d'interclub
// ne doivent jamais partager un journal.

import { isValidBestOf, normalizeColor, replay, type ScoreEvent, type Side } from "@/lib/interclub";

/** Le match libre en cours — un seul à la fois. */
export const CURRENT_KEY = "free:current";
/** Les matchs libres terminés, du plus récent au plus ancien. */
export const HISTORY_KEY = "free:history";
/** Journal d'un match de tournoi marqué au bord du court, jusqu'à l'envoi du résultat. */
export const tournamentKey = (matchId: string) => `free:trn:${matchId}`;

export const MAX_HISTORY = 10;
export const HISTORY_TTL_DAYS = 30;
const DAY_MS = 86_400_000;
export const MAX_NAME_LEN = 40;

export type FreeSide = { name: string; color: string | null };

export type FreeMatch = {
  id: string;
  /** Horodatage (ms) du début : sert au tri et à la péremption de l'historique. */
  startedAt: number;
  home: FreeSide;
  away: FreeSide;
  bestOf: 3 | 5;
  events: ScoreEvent[];
};

/** Nom saisi → nom affichable : espaces réduits, borné, repli si vide. */
export function cleanName(v: unknown, fallback: string): string {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LEN) : "";
  return s || fallback;
}

function parseSide(v: unknown): FreeSide | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== "string" || !o.name.trim()) return null;
  return { name: o.name.slice(0, MAX_NAME_LEN), color: normalizeColor(o.color) };
}

function isEvent(v: unknown): v is ScoreEvent {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const side = o.side === "home" || o.side === "away";
  if (o.t === "point") return side;
  if (o.t === "serve") return side && (o.box === "left" || o.box === "right");
  return false;
}

/**
 * Relit un match depuis une source NON FIABLE (localStorage : version antérieure, édition à la
 * main, stockage corrompu). Tolérant : `null` plutôt qu'une exception — un stockage abîmé doit
 * ramener à l'écran de départ, pas casser la vue.
 */
export function parseMatch(raw: unknown): FreeMatch | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const home = parseSide(o.home);
  const away = parseSide(o.away);
  if (typeof o.id !== "string" || !o.id) return null;
  if (typeof o.startedAt !== "number" || !Number.isFinite(o.startedAt)) return null;
  if (!home || !away || !isValidBestOf(o.bestOf)) return null;
  if (!Array.isArray(o.events) || !o.events.every(isEvent)) return null;
  return { id: o.id, startedAt: o.startedAt, home, away, bestOf: o.bestOf, events: o.events };
}

/** Écarte les matchs de plus de `HISTORY_TTL_DAYS` jours et borne à `MAX_HISTORY`. */
export function pruneHistory(list: readonly FreeMatch[], now = Date.now()): FreeMatch[] {
  return list
    .filter((m) => now - m.startedAt < HISTORY_TTL_DAYS * DAY_MS)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_HISTORY);
}

/** Ajoute un match terminé en tête d'historique (sans doublon), puis élague. */
export function pushHistory(list: readonly FreeMatch[], m: FreeMatch, now = Date.now()): FreeMatch[] {
  return pruneHistory([m, ...list.filter((x) => x.id !== m.id)], now);
}

/**
 * Le résultat en une ligne, prêt à coller dans un message :
 * « Paul bat Marc 3-1 (11-7, 9-11, 11-4, 11-8) ».
 *
 * Écrit du point de vue du VAINQUEUR, comme on l'annonce à voix haute. Match inachevé : scores
 * dans l'ordre de saisie, suffixés « en cours ».
 */
export function resultLine(m: FreeMatch): string {
  const st = replay(m.events, m.bestOf);
  const w: Side | null = st.status === "done" ? st.winner : null;
  const first: Side = w ?? "home";
  const second: Side = first === "home" ? "away" : "home";
  const games = st.games.map((g) => `${g[first]}-${g[second]}`).join(", ");
  const detail = games ? ` (${games})` : "";
  if (w) {
    return `${m[first].name} bat ${m[second].name} ${st.gamesWon[first]}-${st.gamesWon[second]}${detail}`;
  }
  const cur = st.current.home + st.current.away > 0 ? `, ${st.current.home}-${st.current.away}` : "";
  return `${m.home.name} ${st.gamesWon.home}-${st.gamesWon.away} ${m.away.name} (en cours${cur})${
    games ? ` — jeux : ${games}` : ""
  }`;
}

// --- stockage (navigateur) ---------------------------------------------------
//
// Chaque accès est protégé : mode privé, quota plein, stockage bloqué. Même parti pris que le
// marquage d'interclub — perdre la reprise est regrettable, empêcher de compter le serait bien
// plus. Sans stockage, on continue en mémoire.

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* on continue en mémoire */
  }
}

export function removeKey(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* sans importance */
  }
}

export function loadMatch(key: string): FreeMatch | null {
  return parseMatch(read(key));
}

export function saveMatch(key: string, m: FreeMatch) {
  write(key, m);
}

export function loadHistory(now = Date.now()): FreeMatch[] {
  const raw = read(HISTORY_KEY);
  if (!Array.isArray(raw)) return [];
  return pruneHistory(raw.map(parseMatch).filter((m): m is FreeMatch => m !== null), now);
}

export function saveHistory(list: readonly FreeMatch[]) {
  write(HISTORY_KEY, list);
}

/** Identifiant local. `randomUUID` n'existe qu'en contexte sécurisé : repli sinon. */
export function newId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* repli ci-dessous */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
