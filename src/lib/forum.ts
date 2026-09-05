// LE FIL DE DISCUSSION DU CLUB — moteur pur.
//
// Module PUR : aucun import serveur. Il est importé par la route (Node) ET par le composant
// (navigateur), comme `interclub.ts` et `retention.ts`, pour que la limite de longueur soit
// la MÊME des deux côtés. Une limite côté serveur seule laisse l'écran promettre puis
// refuser ; une limite côté client seule ne protège rien.

/**
 * Longueur maximale d'un message, en POINTS DE CODE.
 *
 * 1000 et non 500 comme un commentaire de frais partagé : ici c'est la conversation
 * elle-même, pas une annotation en marge d'autre chose.
 */
export const MAX_FORUM_LEN = 1000;

/**
 * Nettoie et borne le corps d'un message. `null` = rien à écrire (vide, ou mauvais type).
 *
 * ⚠️ TRONQUE EN POINTS DE CODE, PAS EN UNITÉS UTF-16. C'est toute la raison d'être de cette
 * fonction plutôt qu'un `parseOptionalText` de plus. Un emoji occupe DEUX unités UTF-16 :
 * `"…👍".slice(0, n)` tombant pile entre les deux moitiés écrit un demi-caractère en base,
 * définitivement cassé. `[...s]` itère par point de code et coupe entre les caractères.
 *
 * Autre écart assumé avec les champs de l'interclub : on réduit les espaces HORIZONTAUX
 * (`[ \t]`) et non `\s`, pour garder les retours à la ligne. Un message de club en a besoin
 * — une liste de covoiturage sur une seule ligne est illisible. Le rendu s'en charge avec
 * `white-space: pre-wrap`, jamais avec du HTML.
 */
export function parseForumBody(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const compact = v.trim().replace(/[ \t]+/g, " ");
  // Trois retours à la ligne d'affilée ou plus ne veulent rien dire de plus que deux, et
  // laisseraient un message pousser tous les autres hors de l'écran.
  const t = [...compact.replace(/\n{3,}/g, "\n\n")].slice(0, MAX_FORUM_LEN).join("");
  return t || null;
}

/** Longueur d'un message telle que l'utilisateur la compte : en caractères visibles. */
export function forumLength(s: string): number {
  return [...s].length;
}

/**
 * Résumé d'un message pour le corps d'une notification.
 *
 * Coupe elle aussi par point de code, et pose une ellipse plutôt que de laisser croire que
 * le message s'arrête là.
 */
export function forumPreview(body: string, max = 120): string {
  const pts = [...body.replace(/\s+/g, " ").trim()];
  return pts.length <= max ? pts.join("") : `${pts.slice(0, max - 1).join("")}…`;
}
