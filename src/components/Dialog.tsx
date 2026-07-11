"use client";

import { type ReactNode } from "react";
import { useDialog } from "@/lib/useDialog";

// Modale accessible réutilisable : overlay + boîte centrée, fermeture sur Échap et
// sur clic hors de la boîte, focus piégé à l'intérieur (cf. useDialog). Reprend les
// classes .modal-overlay / .modal existantes pour ne rien changer au style.
export function Dialog({
  onClose,
  label,
  closeOnOverlay = true,
  autoFocus = true,
  className,
  children,
}: {
  onClose: () => void;
  label: string;
  // Certaines modales bloquent la fermeture par overlay pendant un envoi (busy).
  closeOnOverlay?: boolean;
  // false = ne pas focus le 1er élément à l'ouverture (évite le clavier mobile sur un
  // champ de recherche). Cf. useDialog.
  autoFocus?: boolean;
  // Modificateur CSS optionnel ajouté à la boîte (ex. "directory").
  className?: string;
  children: ReactNode;
}) {
  const ref = useDialog<HTMLDivElement>(onClose, autoFocus);
  return (
    <div className="modal-overlay" onClick={() => closeOnOverlay && onClose()}>
      <div
        ref={ref}
        className={className ? `modal ${className}` : "modal"}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
