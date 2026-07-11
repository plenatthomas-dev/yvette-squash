import { useEffect, useRef } from "react";

// Éléments naturellement focusables à l'intérieur d'une modale.
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessibilité d'une modale : ferme sur Échap, PIÈGE le focus (Tab / Shift+Tab
 * bouclent à l'intérieur), met le focus dans la modale à l'ouverture et le REND à
 * l'élément qui l'avait avant, à la fermeture. Renvoie une ref à poser sur le
 * conteneur de dialogue (qui doit avoir tabIndex={-1} pour recevoir le focus).
 *
 * `autoFocus` (défaut true) : place le focus sur le 1er élément focusable à l'ouverture.
 * Le passer à FALSE quand ce 1er élément est un champ de saisie qu'on ne veut PAS activer
 * d'emblée (ex. annuaire : sur mobile, focus l'input ⇒ le clavier surgit et masque la
 * liste). On focus alors le conteneur : trap + Échap + annonce lecteur d'écran restent
 * actifs, mais aucun clavier ne s'ouvre tant que l'utilisateur ne tape pas le champ.
 */
export function useDialog<T extends HTMLElement>(onClose: () => void, autoFocus = true) {
  const ref = useRef<T>(null);
  // onClose gardé dans une ref : l'effet ne se relance pas à chaque rendu.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Capté à l'ouverture (valeur stable par modale) → hors deps de l'effet.
  const autoFocusRef = useRef(autoFocus);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = () =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );

    // Focus initial : 1er élément focusable (sauf autoFocus=false → le conteneur, pour ne
    // pas ouvrir le clavier mobile sur un champ de saisie).
    (autoFocusRef.current ? focusables()[0] ?? node : node).focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    node.addEventListener("keydown", onKeyDown);
    return () => {
      node.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, []);

  return ref;
}
