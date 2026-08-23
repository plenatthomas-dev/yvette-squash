// Décision « peut-on recharger la page maintenant sans rien faire perdre ? », utilisée par
// components/UpdateBanner quand un déploiement est détecté (cf. son en-tête pour le pourquoi).
// Logique volontairement SÉPARÉE de la lecture du DOM : elle décide à partir de descripteurs
// simples, donc elle se teste sans navigateur ni jsdom. Le composant, lui, ne fait que traduire
// les champs de la page en `FieldState`.

/** Un champ de saisie de la page, réduit à ce qui compte pour la décision. */
export interface FieldState {
  /** `type` de l'input ("text", "password", "checkbox"…) ; "textarea" pour un <textarea>. */
  type: string;
  value: string;
  /** Le champ est-il réellement visible pour l'utilisateur ? */
  visible: boolean;
}

/**
 * Ce champ porte-t-il une saisie qu'un rechargement ferait perdre ?
 *
 * Non pour un champ MASQUÉ : le planning en porte un en permanence (le sélecteur de date natif
 * `.datepick-hidden`, toujours rempli, ouvert via showPicker()). Le compter rendait le
 * rechargement automatique impossible dès qu'on était connecté — précisément le cas visé.
 * Non plus pour une case à cocher ou un bouton radio : leur état vient des données, pas d'une
 * frappe, et la vue « Frais » en affiche en permanence.
 */
export function hasPendingInput(f: FieldState): boolean {
  if (!f.visible) return false;
  if (f.type === "checkbox" || f.type === "radio") return false;
  return f.value.trim() !== "";
}

/**
 * Peut-on recharger MAINTENANT ? Non si une modale est ouverte (saisie en cours par
 * construction : dépense, tournoi…), ni si un champ visible porte du texte — y compris un mot
 * de passe sur l'écran de connexion. Conservateur : dans le doute, l'appelant affiche la
 * bannière et laisse l'utilisateur choisir son moment.
 */
export function isSafeToReload(dialogOpen: boolean, fields: FieldState[]): boolean {
  if (dialogOpen) return false;
  return !fields.some(hasPendingInput);
}
