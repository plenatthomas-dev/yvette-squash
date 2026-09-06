// LA PASTILLE D'INITIALES d'un auteur.
//
// Volontairement SANS couleur par membre. DESIGN.md réserve la couleur au sens — le vert à
// l'action, la famille d'état à la ligne entière — et le fil dit déjà « c'est moi qui parle »
// par l'alignement et un filet, jamais par une teinte. Une couleur par joueur serait
// décorative, et entrerait en concurrence avec le vert du produit.
//
// Rien à stocker : `displayName` est réécrit depuis ResaMania à chaque connexion
// (cf. session.ts, resolveUser), donc les initiales suivent le nom toutes seules.

/**
 * Découpe en GRAPPES DE GRAPHÈMES, et non en points de code.
 *
 * Le point de code ne suffit pas ici, et c'est un cran de plus que la règle habituelle du
 * domaine. Trois cas réels le montrent, tous à un caractère du début d'un nom :
 *
 *   * « 🇫🇷 Marc »        → deux indicateurs régionaux forment UN drapeau. Prendre le premier
 *                          point de code rend « 🇫 », un demi-drapeau qui s'affiche en lettre.
 *   * « 👨‍👩‍👧 Famille »     → une séquence à jointeur de largeur nulle. Coupée, elle rend « 👨 ».
 *   * « élodie » en NFD  → « e » suivi d'un accent combinant. Le premier point de code est
 *                          « e » nu : la pastille affiche « E » au lieu de « É ».
 *
 * `Intl.Segmenter` est disponible partout où l'appli tourne (Node 20+, tous les navigateurs
 * modernes). Le repli par points de code reste écrit pour les environnements de test qui
 * n'auraient pas l'ICU complet — il rend le comportement d'avant, jamais une exception.
 */
const GRAPPES =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("fr", { granularity: "grapheme" })
    : null;

function premiereLettre(mot: string): string {
  if (!GRAPPES) return [...mot][0] ?? "";
  for (const { segment } of GRAPPES.segment(mot)) return segment;
  return "";
}

/**
 * Une ou deux lettres tirées d'un nom d'affichage.
 */
export function initiales(nom: string): string {
  const mots = nom.trim().split(/\s+/).filter(Boolean);
  if (mots.length === 0) return "?";
  const premier = premiereLettre(mots[0]);
  // Deux lettres seulement à partir de deux mots. « Jean-Baptiste » reste « J » : le trait
  // d'union ne sépare pas deux personnes, et « JB » se lit comme des initiales d'état civil.
  const second = mots.length > 1 ? premiereLettre(mots[mots.length - 1]) : "";
  // La normalisation vient APRÈS la découpe : sur « e + accent combinant », c'est la grappe
  // entière qu'on passe en majuscule, et NFC la recompose en « É ».
  return (premier + second).toLocaleUpperCase("fr-FR").normalize("NFC");
}
