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
  className,
  children,
}: {
  onClose: () => void;
  label: string;
  // Certaines modales bloquent la fermeture par overlay pendant un envoi (busy).
  closeOnOverlay?: boolean;
  // Modificateur CSS optionnel ajouté à la boîte (ex. "directory").
  className?: string;
  children: ReactNode;
}) {
  const ref = useDialog<HTMLDivElement>(onClose);
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
