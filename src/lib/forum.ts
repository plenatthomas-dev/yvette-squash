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
 * Nettoie et valide le corps d'un message. `null` = à refuser : vide, mauvais type, ou TROP
 * LONG. C'est exactement ce que la route promet en rendant « Message invalide (1 à 1000
 * caractères) » — les DEUX bornes, pas seulement la basse.
 *
 * ⚠️ REFUSE, NE TRONQUE PAS. La première version coupait à `MAX_FORUM_LEN` et laissait la
 * route répondre 201 : un compte rendu de 1300 caractères repartait coupé net, sans ellipse
 * ni avertissement, et son auteur croyait avoir tout envoyé. Perdre en silence la moitié d'un
 * message est pire que le refuser. L'écran dit déjà « Message trop long » et désactive
 * l'envoi : ce 400 n'est donc atteint que par un client bricolé ou désynchronisé.
 *
 * La MESURE compte des POINTS DE CODE (`forumLength`), et c'est ce qui rend la limite
 * honnête : un emoji occupe DEUX unités UTF-16, et compter celles-ci refuserait à 500 emoji
 * un message que l'écran annonce comme long de 500 caractères. La découpe par points de code
 * reste la règle partout où l'on coupe pour de bon — `forumPreview`, `parseForumOption` —
 * pour la raison inverse : `slice` tombant entre les deux moitiés d'un emoji écrit un
 * demi-caractère définitivement cassé.
 *
 * Autre écart assumé avec les champs de l'interclub : on réduit les espaces HORIZONTAUX
 * (`[ \t]`) et non `\s`, pour garder les retours à la ligne. Un message de club en a besoin —
 * une liste de covoiturage sur une seule ligne est illisible. Le rendu s'en charge avec
 * `white-space: pre-wrap`, jamais avec du HTML.
 */
export function parseForumBody(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const compact = v.trim().replace(/[ \t]+/g, " ");
  // Trois retours à la ligne d'affilée ou plus ne veulent rien dire de plus que deux, et
  // laisseraient un message pousser tous les autres hors de l'écran.
  const t = compact.replace(/\n{3,}/g, "\n\n");
  if (!t) return null;
  return forumLength(t) > MAX_FORUM_LEN ? null : t;
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

/**
 * Ce que la CLOCHE garde d'un message du fil — délibérément, rien de son contenu.
 *
 * Le push et le journal ne sont pas la même chose, et le fil est ce qui a rendu la différence
 * visible. Le push est transitoire : il s'affiche sur le téléphone de son destinataire, qui le
 * balaie. La ligne `AppNotification` du journal est DURABLE — trente jours — et il y en a une
 * PAR DESTINATAIRE. Y recopier le message revenait à en faire trente copies chez trente
 * personnes, que ni la suppression du message ni celle du compte de son auteur n'atteignent :
 * l'admin qui retire une insulte n'en retirait aucune, et le membre qui part en laissait
 * partout.
 *
 * Le dispositif venait de l'interclub, où le corps journalisé est « Le match a commencé » —
 * sans conséquence. La nature de la donnée a changé, pas le dispositif. Le tag rouvre le fil,
 * où l'état courant fait foi : c'est là qu'il faut aller lire, et nulle part ailleurs.
 */
export const JOURNAL_FORUM = {
  title: "💬 Le fil du club",
  body: "Nouveau message dans le fil.",
  url: "/?view=forum",
  tag: "forum",
} as const;

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
