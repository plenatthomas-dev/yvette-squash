"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// Icône « plus d'options » (trois points) pour le menu déroulant du header.
function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </svg>
  );
}

// Un élément du menu déroulant du header (⋯).
export interface HeaderMenuItem {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  active?: boolean; // vue courante (Frais / Tournoi)
  badge?: number; // pastille (ex. montant à rembourser)
  disabled?: boolean;
  comingSoon?: boolean; // fonction gated OFF → grisée « en dév »
}

// Menu déroulant qui regroupe les actions secondaires du header (Frais, Tournoi, Annuaire,
// Partager, Déconnexion) pour désencombrer l'en-tête et mettre le logo en avant. Ferme au
// clic extérieur et sur Échap. Notifications et Réglages restent HORS du menu (accès direct).
export function HeaderMenu({ items }: { items: HeaderMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      // Rend le focus au déclencheur : sans ça il repart au début du document et
      // l'utilisateur au clavier doit retraverser tout l'en-tête.
      ref.current?.querySelector("button")?.focus();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const anyBadge = items.some((i) => (i.badge ?? 0) > 0);
  const anyActive = items.some((i) => i.active);
  return (
    <div className="header-menu" ref={ref}>
      <button
        className={"secondary icon-btn" + (anyActive ? " active" : "")}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Plus d'options"
        title="Plus d'options"
      >
        <MoreIcon />
        {anyBadge && <span className="badge dot" aria-hidden="true" />}
      </button>
      {open && (
        // `role="menu"` promet le patron menu : flèches haut/bas, Origine/Fin, et focus placé
        // sur le panneau à l'ouverture. Sans ça, un lecteur d'écran annonce « menu »,
        // l'utilisateur active le patron attendu, et rien ne répond — un rôle ARIA qui ment
        // est pire que pas de rôle. Le focus revient au déclencheur à la fermeture (cf. Échap
        // plus haut), sinon il repart au début du document.
        <div
          className="header-menu-panel"
          role="menu"
          onKeyDown={(e) => {
            const focusables = [
              ...e.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="menuitem"]:not(:disabled)',
              ),
            ];
            if (focusables.length === 0) return;
            const i = focusables.indexOf(document.activeElement as HTMLButtonElement);
            const go = (n: number) => {
              e.preventDefault();
              focusables[(n + focusables.length) % focusables.length].focus();
            };
            if (e.key === "ArrowDown") go(i + 1);
            else if (e.key === "ArrowUp") go(i - 1);
            else if (e.key === "Home") go(0);
            else if (e.key === "End") go(focusables.length - 1);
          }}
          ref={(el) => {
            // Focus initial sur le premier item : c'est ce que le patron menu impose.
            el?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
          }}
        >
          {items.map((it) => (
            <button
              key={it.key}
              role="menuitem"
              className={
                "header-menu-item" +
                (it.active ? " active" : "") +
                (it.comingSoon ? " coming-soon" : "")
              }
              disabled={it.disabled}
              onClick={() => {
                it.onClick();
                setOpen(false);
              }}
              title={it.comingSoon ? "🚧 En cours de développement" : it.label}
            >
              <span className="hm-icon">{it.icon}</span>
              <span className="hm-label">{it.label}</span>
              {(it.badge ?? 0) > 0 ? (
                <span className="badge">{it.badge}</span>
              ) : it.comingSoon ? (
                <span className="hm-soon" aria-hidden="true">
                  🚧
                </span>
              ) : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
