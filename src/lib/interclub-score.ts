// LE SCORE PUBLIÉ D'UN SIMPLE, lu pour l'affichage. Pur, partagé par l'écran et le serveur.
//
// La ligue écrit un simple en une chaîne, « 11-4 12-14 11-9 3-11 9-11 », du point de vue du
// côté qu'elle place en premier : le receveur sur la feuille de poule, le côté A sur la feuille
// de match, le joueur lui-même sur sa fiche. Ces fonctions ne décident jamais de ce sens : elles
// le retournent quand on le leur demande, et additionnent ce qu'elles savent lire.

/** Les jeux d'un score, ou null si un seul jeu ne se lit pas (forfait, « WO »…). */
export function jeuxDuScore(score: string | null | undefined): Array<[number, number]> | null {
  const brut = (score ?? "").trim();
  if (!brut) return null;
  const jeux: Array<[number, number]> = [];
  for (const j of brut.split(/\s+/)) {
    const m = /^(\d+)-(\d+)$/.exec(j);
    if (!m) return null;
    jeux.push([Number.parseInt(m[1], 10), Number.parseInt(m[2], 10)]);
  }
  return jeux;
}

/**
 * Le même score vu de l'autre côté : « 5-11 8-11 15-13 » → « 11-5 11-8 13-15 ».
 *
 * Un score qui ne se lit pas est rendu TEL QUEL plutôt qu'à moitié retourné : un texte brut
 * reste vrai, un retournement partiel attribuerait des jeux au mauvais joueur.
 */
export function inverserScore(score: string): string {
  const jeux = jeuxDuScore(score);
  return jeux ? jeux.map(([a, b]) => `${b}-${a}`).join(" ") : score;
}

/** Les totaux d'une rencontre : jeux et points de chaque côté. */
export interface TotauxScore {
  jeux: [number, number];
  points: [number, number];
}

/**
 * Jeux et points cumulés sur des simples, DÉRIVÉS DES SCORES — pour l'affichage seulement.
 *
 * NULL SI UN SEUL SIMPLE JOUÉ NE SE LIT PAS : un total partiel se lirait comme un total (même
 * doctrine que le palmarès, `interclub-stats.ts`, règle 4). Les simples non joués (score vide)
 * ne comptent pas, ils ne manquent pas.
 */
export function totauxDesScores(scores: ReadonlyArray<string | null>): TotauxScore | null {
  const t: TotauxScore = { jeux: [0, 0], points: [0, 0] };
  let joues = 0;
  for (const s of scores) {
    if (!s || !s.trim()) continue;
    const jeux = jeuxDuScore(s);
    if (!jeux) return null;
    joues += 1;
    for (const [a, b] of jeux) {
      if (a > b) t.jeux[0] += 1;
      else if (b > a) t.jeux[1] += 1;
      t.points[0] += a;
      t.points[1] += b;
    }
  }
  return joues > 0 ? t : null;
}
