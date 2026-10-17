"use client";

// Toasts (extraits de page.tsx) : notifications éphémères en surimpression, remplaçant
// alert() natif (moche sur mobile). L'état vit dans la page ; ce composant ne fait que
// rendre la pile. Les types sont exportés car la page les utilise (callback `toast`, état).
//
// UN APPUI SUR UN TOAST LE FERME (`onDismiss`). Ils étaient intappables (`pointer-events: none`
// sur toute la pile) : un toast d'erreur posé sur ce qu'on voulait toucher restait là jusqu'au
// bout de son délai. Seul le CONTENEUR reste transparent aux appuis (cf. globals.css) : la pile
// ne prend que la surface de ses propres toasts, jamais le bouton « Réserver » qu'elle surplombe.
//
// Ni bouton ni place dans l'ordre de tabulation : le toast se retire seul (durée réglée dans
// page.tsx), le fermer n'est qu'un raccourci pour le doigt — en faire une cible clavier
// volerait le focus à chaque notification.

export type ToastType = "ok" | "err" | "info";
export type Toast = { id: number; type: ToastType; msg: string };

const TOAST_ICON: Record<ToastType, string> = { ok: "✅", err: "⚠️", info: "ℹ️" };

/**
 * Durée d'affichage d'un toast, en millisecondes. Elle était de 3,5 s pour TOUT, erreurs
 * comprises — or un toast d'erreur est justement celui qu'on doit lire jusqu'au bout pour
 * savoir quoi faire, et « Réservation impossible : Pas de réseau : vérifie ta connexion et
 * réessaie. » ne se lit pas en 3,5 s par un membre qui n'avait pas les yeux sur l'écran à
 * l'instant où il est apparu.
 *  - erreur : 8 s ;
 *  - information longue (> 80 caractères, soit plus d'une ligne sur téléphone) : 6 s ;
 *  - le reste (« Réservation confirmée ») : 3,5 s, l'information tient en un coup d'œil.
 * Tout toast se ferme aussi d'un appui : allonger la durée ne coûte rien à qui a déjà lu.
 */
export function toastDuration(type: ToastType, msg: string): number {
  if (type === "err") return 8000;
  if (type === "info" && msg.length > 80) return 6000;
  return 3500;
}

export function Toasts({
  items,
  onDismiss,
}: {
  items: Toast[];
  /** Retire un toast avant la fin de son délai (appui dessus). */
  onDismiss?: (id: number) => void;
}) {
  // DEUX régions live, et il en faut deux. Tout passait auparavant en `role="status"`
  // (poli) : une erreur se mettait donc en file derrière les annonces de chargement et
  // pouvait n'arriver qu'après avoir été retirée du DOM. Les erreurs passent en
  // `role="alert"` (assertif, annoncé tout de suite) ; succès et infos restent polis pour
  // ne pas couper la lecture en cours.
  const errors = items.filter((t) => t.type === "err");
  const others = items.filter((t) => t.type !== "err");
  const rendu = (t: Toast) => (
    <div
      key={t.id}
      className={`toast ${t.type}`}
      onClick={onDismiss ? () => onDismiss(t.id) : undefined}
    >
      {TOAST_ICON[t.type]} {t.msg}
    </div>
  );
  return (
    <div className="toasts">
      <div className="toasts-stack" role="alert" aria-live="assertive">
        {errors.map(rendu)}
      </div>
      <div className="toasts-stack" role="status" aria-live="polite">
        {others.map(rendu)}
      </div>
    </div>
  );
}
