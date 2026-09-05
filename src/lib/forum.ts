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

/**
 * La palette de saisie : les emoji offerts sous le champ de message.
 *
 * Elle n'existe QUE pour le clavier physique. Les téléphones en produisent nativement, et
 * c'est là que le fil se lit le plus souvent — mais depuis un ordinateur, un emoji est
 * autrement inatteignable sans quitter l'appli.
 *
 * Aucune bibliothèque : un sélecteur complet pèse plusieurs centaines de kilo-octets pour
 * couvrir des milliers de caractères dont un club de squash en emploie trente.
 */
export const FORUM_EMOJIS = [
  "👍", "👎", "😂", "😅", "🙂", "😉", "😍", "🤔",
  "😮", "😢", "😱", "🙏", "💪", "🔥", "🎉", "👏",
  "❤️", "✅", "❌", "⚠️", "🎾", "🏆", "🥇", "⏰",
  "📅", "🚗", "🍻", "☕", "💬", "👋",
] as const;

/**
 * Les réactions possibles sous un message — une LISTE FERMÉE, et pas la palette ci-dessus.
 *
 * Six suffisent à acquiescer, et la fermeture est une contrainte de stockage autant que de
 * lisibilité : sans elle la colonne `emoji` accepterait n'importe quelle chaîne envoyée par
 * un client bricolé, et une rangée de vingt pastilles différentes sous un message ne dirait
 * plus rien. La route valide contre cette liste, jamais contre un motif.
 */
export const FORUM_REACTIONS = ["👍", "😂", "❤️", "💪", "🎾", "✅"] as const;

export type ForumReactionEmoji = (typeof FORUM_REACTIONS)[number];

/** L'emoji est-il une réaction admise ? Seul contrôle accepté côté serveur. */
export function isForumReaction(v: unknown): v is ForumReactionEmoji {
  return typeof v === "string" && (FORUM_REACTIONS as readonly string[]).includes(v);
}

/** Longueur maximale d'un libellé d'option de sondage, en points de code. */
export const MAX_POLL_OPTION_LEN = 60;
/** Bornes du nombre d'options d'un sondage. Deux, sinon ce n'est pas un choix. */
export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_OPTIONS = 6;

/**
 * Nettoie un libellé d'option. `null` = option vide, donc à refuser.
 *
 * Même découpe par points de code que `parseForumBody`, et pour la même raison : « Chez
 * Marco 🍕 » tronqué à la limite ne doit pas laisser une demi-pizza en base. Ici on réduit
 * TOUS les blancs, retours à la ligne compris — une option de sondage tient sur une ligne.
 */
export function parseForumOption(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = [...v.replace(/\s+/g, " ").trim()].slice(0, MAX_POLL_OPTION_LEN).join("");
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
