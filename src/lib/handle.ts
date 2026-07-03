// Nom affiché dans les créneaux / le « Bonjour ».
//
// Priorité : le PSEUDONYME choisi par le joueur ; à défaut, un diminutif auto
// « 3 lettres du prénom + initiale du nom » :
//   "Thomas Plenat"  -> "Tho.P"
//   "Jo Dupont"      -> "Jo.D"
//   "Cher"           -> "Che"
//
// Dans les créneaux, la place est limitée : un pseudonyme trop long est coupé
// intelligemment sur une frontière de syllabe (voir truncateSyllables).
//
// Homonymes (même token pour 2 joueurs DIFFÉRENTS) : on suffixe le 2ᵉ, 3ᵉ… par un
// numéro ("Tho.P", "Tho.P2"). Attribution déterministe (tri par ancienneté du compte)
// → un joueur garde toujours le même token, quel que soit l'endpoint qui le calcule.

// Longueur cible d'un pseudonyme affiché dans un créneau (hors « … » de troncature).
export const SLOT_HANDLE_MAX = 8;

const VOWELS = "aeiouyàâäéèêëïîôöùûüœæ";
const isVowel = (c: string) => VOWELS.includes(c.toLowerCase());

/** Découpe un mot en syllabes (heuristique française, suffisante pour tronquer). */
function syllabify(word: string): string[] {
  const syl: string[] = [];
  let cur = "";
  for (let i = 0; i < word.length; i++) {
    cur += word[i];
    if (!isVowel(word[i])) continue;
    // Voyelle atteinte : on regarde la suite de consonnes jusqu'à la prochaine voyelle.
    let j = i + 1;
    while (j < word.length && !isVowel(word[j])) j++;
    const cons = word.slice(i + 1, j);
    if (j >= word.length) {
      // Plus de voyelle : les consonnes finales restent avec la syllabe courante.
      cur += cons;
      break;
    }
    if (cons.length > 1) {
      // VC | CV : la 1re consonne reste, les autres démarrent la syllabe suivante.
      cur += cons.slice(0, cons.length - 1);
      i += cons.length - 1;
    }
    // V | CV (0 ou 1 consonne restante) : on coupe ici.
    syl.push(cur);
    cur = "";
  }
  if (cur) syl.push(cur);
  return syl.length ? syl : [word];
}

/**
 * Tronque `name` à ~`max` caractères en coupant sur une frontière de syllabe,
 * et ajoute « … » si on a coupé. Renvoie le nom entier s'il tient déjà.
 */
export function truncateSyllables(name: string, max = SLOT_HANDLE_MAX): string {
  const s = (name ?? "").trim();
  if (s.length <= max) return s;
  let out = "";
  for (const sy of syllabify(s)) {
    if ((out + sy).length > max) break;
    out += sy;
  }
  if (!out) out = s.slice(0, max); // 1re syllabe déjà trop longue : coupe nette
  return `${out}…`;
}

/** Diminutif auto (sans pseudo, sans dé-doublonnage) à partir du nom complet. */
export function baseHandle(fullName: string): string {
  const words = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const given3 = words[0].slice(0, 3);
  const pretty = given3.charAt(0).toUpperCase() + given3.slice(1).toLowerCase();
  const family = words.length > 1 ? words[words.length - 1] : "";
  const initial = family ? family.charAt(0).toUpperCase() : "";
  return initial ? `${pretty}.${initial}` : pretty;
}

type HandleUser = {
  id: string;
  displayName: string;
  nickname?: string | null;
  createdAt?: Date | string;
};

/** Token affiché dans les créneaux pour un joueur : pseudo tronqué, sinon diminutif. */
function slotToken(u: HandleUser): string {
  const nick = (u.nickname ?? "").trim();
  return nick ? truncateSyllables(nick) : baseHandle(u.displayName);
}

/**
 * Table userId → token dé-doublonné pour un ensemble d'utilisateurs.
 * Passer TOUS les joueurs connus (le suffixe d'homonyme dépend de l'ensemble) ;
 * le tri par ancienneté garantit un résultat stable entre les appels.
 */
export function buildHandleMap(users: HandleUser[]): Map<string, string> {
  const sorted = [...users].sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const counts = new Map<string, number>();
  const out = new Map<string, string>();
  for (const u of sorted) {
    const base = slotToken(u);
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    out.set(u.id, n === 1 ? base : `${base}${n}`);
  }
  return out;
}
