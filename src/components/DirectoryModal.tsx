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
  // "" = pas de filtre (toutes les équipes, plus les joueurs qui n'en ont pas).
  //
  // C'est le SEUL filtre. Il y en avait deux autres — classement et catégorie d'âge — et ils
  // occupaient une ligne entière au-dessus d'une liste dont la recherche par nom fait déjà
  // l'essentiel du travail. Filtrer sur « 5A » ou « +55 » ne répond à aucune question qu'on se
  // pose vraiment devant un annuaire de club ; « qui est dans l'équipe 1 ? » si, et c'est
  // précisément la question qu'aucun écran ne savait rendre.
  const [filterTeam, setFilterTeam] = useState("");

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
  const found = (members ?? []).filter(
    (m) => m.name.toLowerCase().includes(needle) && (!filterTeam || m.team === filterTeam),
  );
  // `found` vient déjà trié par nom (serveur) : trier par rang part donc d'une base alpha
  // stable, ce qui range naturellement les ex æquo et les sans-classement par ordre alpha.
  const shown = sort === "rank" ? [...found].sort(byRank) : found;
  // La bascule de tri n'a de sens que si au moins un membre a un classement (flag `ranking`
  // actif ET rapprochement squashnet réussi) — sinon les deux ordres seraient identiques.
  const anyRanked = (members ?? []).some((m) => m.rangM != null);

  // Équipes réellement présentes, dérivées de la liste chargée et non d'une liste figée : le
  // club en engage deux aujourd'hui, une troisième ne coûtera qu'une ligne en base et doit
  // apparaître ici sans qu'on y touche. Calculées sur la liste NON filtrée, sans quoi choisir
  // une équipe ferait disparaître les autres du sélecteur — sans retour en arrière possible.
  // Tri alpha : « Équipe 1 » avant « Équipe 2 ».
  const teamOptions = Array.from(
    new Set((members ?? []).flatMap((m) => (m.team ? [m.team] : []))),
  ).sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }));

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
            {/* Un contrôle segmenté et non un menu déroulant : à deux ou trois équipes, les
                choix tiennent sur la ligne et se lisent sans être ouverts — et l'équipe active
                se voit sans avoir à relire le libellé du champ. Même vocabulaire que la bascule
                de tri juste en dessous (`.directory-sort`), pour que deux contrôles voisins qui
                font la même sorte de chose se ressemblent. */}
            {teamOptions.length > 0 && (
              <div className="directory-filters" role="group" aria-label="Filtrer par équipe">
                <button type="button" aria-pressed={!filterTeam} onClick={() => setFilterTeam("")}>
                  Tous
                </button>
                {teamOptions.map((t) => (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={filterTeam === t}
                    onClick={() => setFilterTeam(t)}
                    title={t}
                  >
                    {/* « Équipe 1 » → « Éq. 1 » : trois équipes tiennent alors sur une ligne de
                        téléphone à côté de « Tous ». Le libellé complet reste au survol et pour
                        les lecteurs d'écran. */}
                    <span aria-hidden="true">{t.replace(/^Équipe\s+/i, "Éq. ")}</span>
                    <span className="sr-only">{t}</span>
                  </button>
                ))}
              </div>
            )}
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
                    {m.team && (
                      // Pastille sobre : l'équipe est une information d'appartenance, pas une
                      // action — donc ni vert ni couleur de marque (cf. DESIGN.md).
                      <span className="directory-team" title="Équipe interclub">
                        <span className="sr-only">Équipe interclub : </span>
                        {m.team}
                      </span>
                    )}
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
              Seuls les membres ayant choisi d&apos;apparaître sont listés. Pour t&apos;ajouter
              ou te retirer : ⚙️ Paramètres › « Annuaire des membres ». Les joueurs d&apos;une
              équipe interclub qui n&apos;ont pas l&apos;appli y figurent aussi, inscrits par un
              administrateur.
            </p>
            <div className="modal-actions">
              <button className="secondary" onClick={onClose}>
                Fermer
              </button>
            </div>
        </Dialog>
  );
}
