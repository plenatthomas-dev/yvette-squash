"use client";

import { Dialog } from "@/components/Dialog";
import { PrivacyContent } from "@/components/PrivacyContent";

/**
 * La note, dans sa modale, chargée à la demande au premier clic (cf. `PrivacyNotice`) : quatre
 * cents lignes de texte qui n'ont rien à faire dans le premier chargement (audit 2026-10, point
 * 27). Le texte lui-même vit dans `PrivacyContent`, que la page publique /confidentialite partage.
 */
export default function PrivacyDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog onClose={onClose} label="Confidentialité et données" className="privacy">
      <h3>Confidentialité &amp; données</h3>
      <div className="privacy-body">
        <PrivacyContent />
      </div>
      <div className="modal-actions">
        <button className="secondary" onClick={onClose}>
          Fermer
        </button>
      </div>
    </Dialog>
  );
}
