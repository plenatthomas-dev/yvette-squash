// Règles d'ORDRE de l'annuaire. Séparé de `directoryCache` (qui ne fait que mémoïser l'appel
// réseau) : ce sont deux responsabilités distinctes, et seule celle-ci est du ressort de
// l'affichage. Fonction pure, donc testable sans DOM.

import type { DirectoryMember } from "@/lib/directoryCache";

/**
 * Palier de comparaison d'un membre. La règle cardinale : on ne soustrait JAMAIS deux rangs
 * d'échelles différentes. `rangM` (mixte) compare tout le monde ; `rang` situe chacun dans son
 * genre. Comme `rangM >= rang` toujours, les mélanger avantagerait systématiquement celui dont
 * le rang mixte manque — il passerait devant des joueurs bien plus forts.
 *
 * D'où trois paliers étanches, dans cet ordre :
 *   1. rang mixte connu    → comparés entre eux, c'est le classement de référence ;
 *   2. seulement le rang de genre → comparés entre eux, APRÈS tous ceux du palier 1. On ne
 *      prétend pas les situer face au palier 1, mais on les ordonne quand même entre eux ;
 *   3. aucun classement    → en fin de liste. Ne pas savoir n'est pas être dernier, mais il
 *      faut bien les mettre quelque part, et une liste alphabétique s'y lit très bien.
 */
function tier(m: DirectoryMember): number {
  if (m.rangM != null) return 1;
  if (m.rang != null) return 2;
  return 3;
}

/**
 * Comparateur « par classement » : rang le plus PETIT en tête (le mieux classé). Partagé par
 * l'annuaire ET le pré-remplissage des têtes de série du tournoi — deux écrans qui ordonnent
 * les mêmes membres ne doivent pas pouvoir diverger.
 *
 * À appliquer sur une liste DÉJÀ triée par nom (ce que renvoie /api/directory) : le tri de
 * `Array.prototype.sort` étant stable, les ex æquo et les sans-classement restent alors en
 * ordre alphabétique.
 */
export function byRank(a: DirectoryMember, b: DirectoryMember): number {
  const ta = tier(a);
  const tb = tier(b);
  if (ta !== tb) return ta - tb;
  if (ta === 1) return (a.rangM as number) - (b.rangM as number);
  if (ta === 2) return (a.rang as number) - (b.rang as number);
  return 0;
}
