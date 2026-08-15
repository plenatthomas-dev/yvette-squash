"use client";

import { useEffect, useState } from "react";
import { Dialog } from "@/components/Dialog";
import { fetchDirectory, getDirectoryGroupUrl, type DirectoryMember } from "@/lib/directoryCache";
import { byRank } from "@/lib/directorySort";

// Ordre d'affichage. « name » est celui du serveur (déjà trié) et reste le défaut : on cherche
// d'abord quelqu'un par son nom. « rank » classe du mieux classé au moins bien (cf. byRank).
type SortKey = "name" | "rank";

// Annuaire des membres (idée 6). Bouton d'en-tête → modale listant les joueurs opt-in,
// avec une recherche par nom. Gated par le flag `directory` : grisé (« bientôt ») si OFF,
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
  const [members, setMembers] = useState<DirectoryMember[] | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("name");
  const [groupUrl, setGroupUrl] = useState<string | null>(null);

  // Charge la liste à l'ouverture. Cache mémoire court (cf. fetchDirectory) : une
  // réouverture rapprochée (ou après passage par Réglages) ne refait pas d'aller-retour.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setMembers(null);
    (async () => {
      try {
        const members = await fetchDirectory();
        if (!cancelled) {
          setMembers(members);
          setGroupUrl(getDirectoryGroupUrl());
        }
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
  const found = (members ?? []).filter((m) => m.name.toLowerCase().includes(needle));
  // `found` vient déjà trié par nom (serveur) : trier par rang part donc d'une base alpha
  // stable, ce qui range naturellement les ex æquo et les sans-classement par ordre alpha.
  const shown = sort === "rank" ? [...found].sort(byRank) : found;
  // La bascule de tri n'a de sens que si au moins un membre a un classement (flag `ranking`
  // actif ET rapprochement squashnet réussi) — sinon les deux ordres seraient identiques.
  const anyRanked = (members ?? []).some((m) => m.rangM != null);

  if (!open) return null;
  return (
        <Dialog onClose={onClose} label="Annuaire des membres" className="directory" autoFocus={false}>
            <h3>Annuaire des membres</h3>
            {groupUrl && (
              <a
                className="wa-group-link"
                href={groupUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                💬 Groupe WhatsApp de l'asso
              </a>
            )}
            <input
              type="search"
              className="directory-search"
              placeholder="Rechercher un membre…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Rechercher un membre"
            />
            {anyRanked && (
              <>
                <div className="directory-sort" role="group" aria-label="Trier l'annuaire">
                  <button
                    type="button"
                    aria-pressed={sort === "name"}
                    onClick={() => setSort("name")}
                  >
                    A → Z
                  </button>
                  <button
                    type="button"
                    aria-pressed={sort === "rank"}
                    onClick={() => setSort("rank")}
                  >
                    Classement
                  </button>
                </div>
                {/* Légende VISIBLE : sans elle, « #2339 » est un nombre nu. L'info-bulle ne
                    suffit pas — l'appli s'utilise au doigt, et `title` ne se déclenche jamais
                    au tactile (même limite que le badge de classement, elle pré-existe). */}
                <p className="directory-legend muted">
                  <strong>#</strong> rang national, toutes catégories
                </p>
              </>
            )}
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
                    {m.rangM != null && (
                      <span className="directory-rang" title="Rang national, toutes catégories">
                        {/* Texte pour lecteur d'écran plutôt qu'un aria-label : ARIA ne garantit
                            pas l'exposition d'une étiquette sur un <span> sans rôle. Le « # »
                            visible, lui, ne se lit pas à voix haute. */}
                        <span className="sr-only">Rang national toutes catégories : </span>
                        <span aria-hidden="true">#</span>
                        {m.rangM}
                      </span>
                    )}
                    {m.clt && (
                      <span
                        className="directory-clt"
                        title={
                          "Classement fédéral" +
                          (m.rang ? ` · rang dans son genre ${m.rang}` : "") +
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
