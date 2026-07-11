"use client";

import { useEffect, useState } from "react";
import { Dialog } from "@/components/Dialog";
import { fetchDirectory } from "@/lib/directoryCache";

// Annuaire des membres (idée 6). Bouton d'en-tête → modale listant les joueurs opt-in,
// avec une recherche par nom. Gated par FEATURE_DIRECTORY : grisé (« bientôt ») si OFF,
// à l'image du bouton Frais. Lecture seule ici (les usages — message, etc. — viendront).
export function DirectoryModal({
  open,
  onClose,
  toast,
}: {
  open: boolean;
  onClose: () => void;
  toast: (type: "ok" | "err" | "info", msg: string) => void;
}) {
  const [members, setMembers] = useState<
    { id: string; name: string; clt?: string; rang?: number | null; cat?: string | null }[] | null
  >(null);
  const [q, setQ] = useState("");

  // Charge la liste à l'ouverture. Cache mémoire court (cf. fetchDirectory) : une
  // réouverture rapprochée (ou après passage par Réglages) ne refait pas d'aller-retour.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setMembers(null);
    (async () => {
      try {
        const members = await fetchDirectory();
        if (!cancelled) setMembers(members);
      } catch (e) {
        if (!cancelled) {
          setMembers([]);
          toast("err", (e as Error).message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, toast]);

  const needle = q.trim().toLowerCase();
  const shown = (members ?? []).filter((m) => m.name.toLowerCase().includes(needle));

  if (!open) return null;
  return (
        <Dialog onClose={onClose} label="Annuaire des membres" className="directory" autoFocus={false}>
            <h3>Annuaire des membres</h3>
            <input
              type="search"
              className="directory-search"
              placeholder="Rechercher un membre…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Rechercher un membre"
            />
            {members === null ? (
              <p className="muted tiny">Chargement…</p>
            ) : shown.length === 0 ? (
              <p className="muted tiny">
                {members.length === 0
                  ? "Aucun membre visible pour le moment."
                  : "Aucun résultat."}
              </p>
            ) : (
              <ul className="directory-list">
                {shown.map((m) => (
                  <li key={m.id}>
                    <span className="directory-name">{m.name}</span>
                    {m.clt && (
                      <span
                        className="directory-clt"
                        title={
                          "Classement fédéral" +
                          (m.rang ? ` · rang national ${m.rang}` : "") +
                          (m.cat ? ` · ${m.cat}` : "")
                        }
                      >
                        {m.clt}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="muted tiny">
              Seuls les membres ayant choisi d'apparaître sont listés. Pour t'ajouter ou te
              retirer : ⚙️ Paramètres › « Annuaire des membres ».
            </p>
            <div className="modal-actions">
              <button className="secondary" onClick={onClose}>
                Fermer
              </button>
            </div>
        </Dialog>
  );
}
