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
 * Une ou deux lettres tirées d'un nom d'affichage.
 *
 * Découpe en POINTS DE CODE (`[...]`) et non en unités UTF-16 : un pseudonyme peut commencer
 * par un caractère hors BMP (un emoji, par exemple), que `charAt` couperait en deux moitiés
 * invalides. Même raison que la troncature de `parseForumBody`.
 */
export function initiales(nom: string): string {
  const mots = nom.trim().split(/\s+/).filter(Boolean);
  if (mots.length === 0) return "?";
  const premier = [...mots[0]][0] ?? "";
  // Deux lettres seulement à partir de deux mots. « Jean-Baptiste » reste « J » : le trait
  // d'union ne sépare pas deux personnes, et « JB » se lit comme des initiales d'état civil.
  const second = mots.length > 1 ? ([...mots[mots.length - 1]][0] ?? "") : "";
  return (premier + second).toLocaleUpperCase("fr-FR");
}
