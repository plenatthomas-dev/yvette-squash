// ============================================================================
//  LES VUES DE L'APPLI, ÉNUMÉRÉES UNE SEULE FOIS.
//
//  ⚠️ CE MODULE EXISTE PARCE QUE LA MÊME PANNE S'EST PRODUITE DEUX FOIS.
//
//  L'union des vues était recopiée à trois endroits de `page.tsx` : le
//  `useState`, le test « vue plein écran », et le garde-fou qui RELIT la vue au
//  démarrage depuis l'URL et localStorage. Ajouter une vue aux deux premiers et
//  l'oublier au troisième donne un symptôme qui n'accuse rien : la vue s'écrit
//  correctement dans l'URL et dans localStorage, puis est refusée à la
//  relecture et ramenée sur « day ». Autrement dit « je rafraîchis et je repars
//  sur les créneaux », sans la moindre erreur, sur tous les environnements.
//
//  C'est arrivé au Fil, puis à l'écran Capitaine. Une seule source, désormais :
//  le TYPE est dérivé de la liste, et le garde-fou INTERROGE la liste au lieu
//  de la recopier. Ajouter une vue à `VIEWS` suffit — et le test qui accompagne
//  ce module vérifie que chacune d'elles survit à un rafraîchissement.
// ============================================================================

/** Toutes les vues, dans l'ordre où le menu les propose. */
export const VIEWS = [
  "day",
  "week",
  "money",
  "tourney",
  "interclub",
  "forum",
  "captain",
] as const;

export type View = (typeof VIEWS)[number];

/**
 * Vues « plein écran », affichées sans le chrome du planning.
 *
 * Tout sauf le planning lui-même (`day` et sa déclinaison `week`). Exprimé comme une
 * SOUSTRACTION plutôt qu'une seconde liste : une vue ajoutée à `VIEWS` est plein écran par
 * défaut, ce qui est le cas de toutes celles ajoutées depuis l'origine — et l'oubli, s'il
 * arrive, se voit tout de suite à l'écran au lieu de se cacher dans un rafraîchissement.
 */
export const PLANNING_VIEWS: readonly View[] = ["day", "week"];

export function isSpecialView(v: View): boolean {
  return !PLANNING_VIEWS.includes(v);
}

/**
 * Cette valeur, lue de l'URL ou de localStorage, est-elle une vue connue ?
 *
 * C'est LE point où les deux pannes se sont produites. Il interroge `VIEWS` : il ne peut plus
 * se désynchroniser d'elle.
 */
export function isView(x: string | null | undefined): x is View {
  return typeof x === "string" && (VIEWS as readonly string[]).includes(x);
}

/**
 * La vue à ouvrir au démarrage, d'après l'URL puis localStorage. `null` = garder le défaut.
 *
 * ⚠️ LA SEMAINE NE S'OUVRE JAMAIS AU LANCEMENT, et c'est la seule exception. `/api/week` fait
 * sept appels à ResaMania : la poser sur le chemin critique du démarrage ferait attendre à
 * chaque ouverture de l'appli quelqu'un qui voulait juste voir sa journée. Elle reste à un clic
 * une fois l'appli chargée.
 *
 * L'URL PRIME SUR localStorage : un lien partagé ouvre ce qu'il désigne, et non ce que le
 * destinataire regardait la dernière fois.
 */
export function viewAtStartup(
  urlParam: string | null,
  stored: string | null,
): View | null {
  const v = isView(urlParam) ? urlParam : isView(stored) ? stored : null;
  if (v === null || v === "week") return null;
  return v;
}
