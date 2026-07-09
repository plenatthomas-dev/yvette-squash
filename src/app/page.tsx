"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import dynamic from "next/dynamic";
import QRCode from "qrcode";
import type { PlanningDay, Slot } from "@/lib/resamania/types";
import { PlanningGrid } from "@/components/PlanningGrid";
import { WeekGrid } from "@/components/WeekGrid";
import { Dialog } from "@/components/Dialog";
// Tricount chargé à la demande (seulement à l'ouverture de la vue « Frais ») : son JS ne
// pèse plus sur le bundle initial de la page. Rendu client uniquement (déjà dans "use client").
const Tricount = dynamic(() => import("@/components/Tricount"), { ssr: false });
// Idem pour le module Tournoi (vue « Tournoi ») : chargé seulement à l'ouverture.
const Tournament = dynamic(() => import("@/components/Tournament"), { ssr: false });
import { fmtTime, slotMinutes } from "@/lib/time";
import { downloadIcs } from "@/lib/ics";
import {
  ensurePushSubscribed,
  pushSupported,
  pushEnabledOnServer,
} from "@/lib/pushClient";
import {
  FEATURE_TRICOUNT,
  FEATURE_EMAIL_LOGIN,
  FEATURE_DIRECTORY,
  FEATURE_DELEGATION,
  FEATURE_TOURNAMENT,
  FEATURE_RANKING,
} from "@/lib/features";
import { DELEGATION_DURATIONS } from "@/lib/delegation-shared";

function toISODate(d: Date): string {
  return d.toLocaleDateString("en-CA"); // YYYY-MM-DD local
}
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}
// Jour sur lequel l'app s'ouvre par défaut : aujourd'hui, ou DEMAIN s'il est déjà tard
// (≥ 21 h), car il ne reste alors plus guère de créneaux jouables le soir même.
function defaultOpenDate(): string {
  const now = new Date();
  const today = toISODate(now);
  return now.getHours() >= 21 ? addDays(today, 1) : today;
}
function prettyDate(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}
// Format compact pour la barre d'outils (« mer. 1 juil. »), plus économe en largeur.
function shortPretty(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("fr-FR", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}
// --- Semaine -----------------------------------------------------------------
function mondayOf(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  const off = (d.getDay() + 6) % 7; // 0 = lundi
  d.setDate(d.getDate() - off);
  return toISODate(d);
}
function weekLabel(date: string): string {
  const mon = mondayOf(date);
  const sun = addDays(mon, 6);
  const f = (d: string) =>
    new Date(`${d}T12:00:00`).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  return `${f(mon)} – ${f(sun)}`;
}

// --- Filtre de plage horaire -------------------------------------------------
type Range = "all" | "morning" | "afternoon" | "evening";
const RANGES: { key: Range; label: string }[] = [
  { key: "all", label: "Journée" },
  { key: "morning", label: "Matin" },
  { key: "afternoon", label: "Après-midi" },
  { key: "evening", label: "Soir" },
];
function isRange(v: unknown): v is Range {
  return v === "all" || v === "morning" || v === "afternoon" || v === "evening";
}
function inRange(iso: string, r: Range): boolean {
  const t = slotMinutes(iso);
  switch (r) {
    case "morning": // 9h00 → 12h30 inclus
      return t >= 9 * 60 && t <= 12 * 60 + 30;
    case "afternoon": // 13h00 → 16h30 inclus
      return t >= 13 * 60 && t <= 16 * 60 + 30;
    case "evening": // à partir de 17h00
      return t >= 17 * 60;
    default:
      return true;
  }
}

// Icône « déconnexion » (flèche sortant d'une porte)
function LogoutIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

// Thèmes disponibles. "rose" = variante « pinky » (voir globals.css). Persisté en localStorage.
type Theme = "system" | "light" | "dark" | "rose";
const THEMES: { key: Theme; label: string }[] = [
  { key: "system", label: "Système" },
  { key: "light", label: "Clair" },
  { key: "dark", label: "Sombre" },
  { key: "rose", label: "Short Rose" },
];
function isTheme(v: unknown): v is Theme {
  return v === "system" || v === "light" || v === "dark" || v === "rose";
}
function applyTheme(t: Theme) {
  const el = document.documentElement;
  if (t === "system") el.removeAttribute("data-theme"); // Pico suit prefers-color-scheme
  else el.setAttribute("data-theme", t);
}
// Icône par thème : soleil (clair), lune (sombre), écran (système), short (rose).
function ThemeIcon({ theme }: { theme: Theme }) {
  const p = {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (theme === "light") {
    return (
      <svg {...p}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }
  if (theme === "dark") {
    return (
      <svg {...p}>
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
    );
  }
  if (theme === "rose") {
    // Short (bermuda) : ceinture + deux jambes avec échancrure centrale.
    return (
      <svg {...p}>
        <path d="M5 5H19L18 19H13L12 11L11 19H6Z" />
        <path d="M5 8H19" />
      </svg>
    );
  }
  // Système : écran + pied.
  return (
    <svg {...p}>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}
// Icône « roue crantée » (paramètres)
function GearIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

// Icône « RAZ » (flèche de réinitialisation) — efface le pseudonyme.
function ResetIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  );
}

// Icône « cloche » (alertes « créneau libéré »)
// Icône « € » (accès aux frais partagés / tricount)
function EuroIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.5 5.5A7.5 7.5 0 0 0 6.8 8.5M17.5 18.5a7.5 7.5 0 0 1-10.7-3M4 10h9M4 14h8" />
    </svg>
  );
}

// Icône « trophée » pour le bouton Tournoi.
function TrophyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 4h12v4a6 6 0 0 1-12 0V4Z" />
      <path d="M6 6H3v2a3 3 0 0 0 3 3M18 6h3v2a3 3 0 0 1-3 3" />
      <path d="M9 20h6M12 14v6" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

// Icône « membres » (deux silhouettes) pour le bouton annuaire.
function UsersIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

// En-tête d'une section de Paramètres : titre + petit bouton « i » qui déplie/replie
// l'explication (les phrases longues n'occupent plus la modale en permanence).
function SettingInfo({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="setting-head">
        <h4>{title}</h4>
        <button
          type="button"
          className="info-tip-btn"
          aria-expanded={open}
          aria-label={`${open ? "Masquer" : "Afficher"} l'explication : ${title}`}
          title="Qu'est-ce que c'est ?"
          onClick={() => setOpen((o) => !o)}
        >
          i
        </button>
      </div>
      {open && <p className="muted tiny setting-info-text">{children}</p>}
    </>
  );
}

// Annuaire des membres (idée 6). Bouton d'en-tête → modale listant les joueurs opt-in,
// avec une recherche par nom. Gated par FEATURE_DIRECTORY : grisé (« bientôt ») si OFF,
// à l'image du bouton Frais. Lecture seule ici (les usages — message, etc. — viendront).
function DirectoryButton({ toast }: { toast: (type: ToastType, msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<{ id: string; name: string; clt?: string }[] | null>(
    null,
  );
  const [q, setQ] = useState("");

  // Charge la liste à l'ouverture (à chaque fois : elle peut avoir bougé).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setMembers(null);
    (async () => {
      try {
        const res = await fetch("/api/directory");
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);
        if (!cancelled) setMembers(data.members ?? []);
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

  return (
    <>
      <button
        className={"secondary icon-btn" + (FEATURE_DIRECTORY ? "" : " coming-soon")}
        onClick={() => FEATURE_DIRECTORY && setOpen(true)}
        disabled={!FEATURE_DIRECTORY}
        aria-label={FEATURE_DIRECTORY ? "Annuaire des membres" : "Annuaire — en cours de développement"}
        title={FEATURE_DIRECTORY ? "Annuaire des membres" : "🚧 En cours de développement"}
      >
        <UsersIcon />
      </button>
      {open && (
        <Dialog onClose={() => setOpen(false)} label="Annuaire des membres" className="directory">
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
                      <span className="directory-clt" title="Classement fédéral">
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
              <button className="secondary" onClick={() => setOpen(false)}>
                Fermer
              </button>
            </div>
        </Dialog>
      )}
    </>
  );
}

// Panneau de paramètres : choix du thème (dont « Short Rose ») + choix du pseudonyme.
function SettingsButton({
  nickname,
  listed,
  onProfileSaved,
  toast,
}: {
  nickname: string | null;
  listed: boolean;
  onProfileSaved: () => void;
  toast: (type: ToastType, msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>("system");
  const [nick, setNick] = useState(nickname ?? "");
  const [saving, setSaving] = useState(false);
  // État optimiste de la case « annuaire » : bascule tout de suite, se resync sur `listed`.
  const [listedLocal, setListedLocal] = useState(listed);
  const [savingListed, setSavingListed] = useState(false);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  // Doit rester synchronisé avec MAX_LEN côté serveur (api/feedback/route.ts).
  const COMMENT_MAX = 1000;

  // Délégation (idée 4) : liste des membres (pour choisir un délégué) + délégation
  // sortante active éventuelle. Chargées à l'ouverture du panneau (peuvent avoir bougé).
  const [delegateMembers, setDelegateMembers] = useState<
    { id: string; name: string }[] | null
  >(null);
  const [outgoingDelegation, setOutgoingDelegation] = useState<{
    id: string;
    delegateId: string;
    delegateName: string;
    expiresAt: string;
  } | null>(null);
  const [pickedDelegate, setPickedDelegate] = useState("");
  const [pickedHours, setPickedHours] = useState<number>(DELEGATION_DURATIONS[0].hours);
  const [delegating, setDelegating] = useState(false);

  useEffect(() => {
    if (!open || !FEATURE_DELEGATION) return;
    let cancelled = false;
    (async () => {
      try {
        const [dirRes, delRes] = await Promise.all([
          fetch("/api/directory"),
          fetch("/api/delegations"),
        ]);
        const dir = await dirRes.json().catch(() => ({}));
        const del = await delRes.json().catch(() => ({}));
        if (cancelled) return;
        setDelegateMembers(dirRes.ok ? (dir.members ?? []) : []);
        setOutgoingDelegation(delRes.ok ? (del.outgoing ?? null) : null);
      } catch {
        if (!cancelled) {
          setDelegateMembers([]);
          setOutgoingDelegation(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const createDelegation = async () => {
    if (!pickedDelegate) return;
    setDelegating(true);
    try {
      const res = await fetch("/api/delegations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delegateId: pickedDelegate, hours: pickedHours }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);
      const delegate = (delegateMembers ?? []).find((m) => m.id === pickedDelegate);
      setOutgoingDelegation({
        id: data.id,
        delegateId: pickedDelegate,
        delegateName: delegate?.name ?? "ce membre",
        expiresAt: data.expiresAt,
      });
      toast("ok", "Délégation activée");
    } catch (e) {
      toast("err", (e as Error).message);
    } finally {
      setDelegating(false);
    }
  };

  const revokeDelegation = async () => {
    if (!outgoingDelegation) return;
    setDelegating(true);
    try {
      const res = await fetch(`/api/delegations/${outgoingDelegation.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`Erreur ${res.status}`);
      setOutgoingDelegation(null);
      toast("ok", "Délégation révoquée");
    } catch (e) {
      toast("err", (e as Error).message);
    } finally {
      setDelegating(false);
    }
  };

  useEffect(() => {
    const saved = localStorage.getItem("theme");
    const t: Theme = isTheme(saved) ? saved : "system";
    setTheme(t);
    applyTheme(t);
  }, []);

  // Resynchronise le champ quand le pseudo change côté serveur / à l'ouverture.
  useEffect(() => {
    if (open) setNick(nickname ?? "");
  }, [open, nickname]);

  // Idem pour la case annuaire.
  useEffect(() => {
    setListedLocal(listed);
  }, [listed]);

  const pickTheme = (t: Theme) => {
    setTheme(t);
    localStorage.setItem("theme", t);
    applyTheme(t);
  };

  // Enregistre un pseudo (ou null pour l'effacer). `close` ferme le panneau après succès.
  const persist = async (value: string | null, close: boolean) => {
    setSaving(true);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);
      toast("ok", value ? "Pseudonyme enregistré" : "Pseudonyme retiré");
      onProfileSaved();
      if (close) setOpen(false);
    } catch (e) {
      toast("err", (e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const saveNick = () => persist(nick.trim() ? nick : null, true);

  // Bascule la visibilité dans l'annuaire (opt-out). Optimiste : on met à jour la case tout
  // de suite, puis on PATCH ; en cas d'échec on revient en arrière.
  const toggleListed = async (next: boolean) => {
    setListedLocal(next);
    setSavingListed(true);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listed: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);
      toast("ok", next ? "Tu apparais dans l'annuaire" : "Tu es retiré de l'annuaire");
      onProfileSaved();
    } catch (e) {
      setListedLocal(!next); // rollback
      toast("err", (e as Error).message);
    } finally {
      setSavingListed(false);
    }
  };
  const clearNick = () => {
    setNick("");
    persist(null, false); // RAZ : efface le pseudo, panneau ouvert pour resaisir
  };

  const sendComment = async () => {
    if (!comment.trim()) return;
    setSending(true);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: comment }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);
      toast("ok", "Merci ! Ton message a été envoyé.");
      setComment("");
    } catch (e) {
      toast("err", (e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <button
        className="secondary icon-btn"
        onClick={() => setOpen(true)}
        aria-label="Paramètres"
        title="Paramètres"
      >
        <GearIcon />
      </button>
      {open && (
        <Dialog onClose={() => setOpen(false)} label="Paramètres" className="settings">
            <h3>Paramètres</h3>

            <section className="setting">
              <h4>Thème</h4>
              <div className="theme-choices" role="group" aria-label="Thème">
                {THEMES.map((t) => (
                  <button
                    key={t.key}
                    className={
                      "theme-chip" +
                      (t.key === "rose" ? " theme-chip--rose" : "") +
                      (theme === t.key ? " active" : "")
                    }
                    aria-pressed={theme === t.key}
                    aria-label={t.label}
                    title={t.label}
                    onClick={() => pickTheme(t.key)}
                  >
                    <ThemeIcon theme={t.key} />
                  </button>
                ))}
              </div>
            </section>

            <section className="setting">
              <h4>Pseudonyme</h4>
              <p className="muted tiny">
                Affiché à la place de ton prénom. Laisse vide pour revenir au prénom.
              </p>
              <div className="nick-field">
                <input
                  type="text"
                  value={nick}
                  maxLength={24}
                  placeholder="Ton pseudo"
                  onChange={(e) => setNick(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveNick();
                  }}
                />
                <button onClick={saveNick} disabled={saving}>
                  {saving ? "…" : "Enregistrer"}
                </button>
                {(nickname || nick.trim()) && (
                  <button
                    className="secondary icon-btn"
                    onClick={clearNick}
                    disabled={saving}
                    aria-label="Effacer le pseudonyme"
                    title="Effacer le pseudonyme"
                  >
                    <ResetIcon />
                  </button>
                )}
              </div>
            </section>

            {FEATURE_DIRECTORY && (
              <section className="setting">
                <SettingInfo title="Annuaire des membres">
                  Par défaut, ton nom (ou pseudo) apparaît dans l'annuaire des membres pour
                  faciliter l'entraide entre joueurs. Tu peux t'en retirer à tout moment.
                </SettingInfo>
                <label className="check-row">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={listedLocal}
                    disabled={savingListed}
                    onChange={(e) => toggleListed(e.target.checked)}
                  />
                  <span>Apparaître dans l'annuaire</span>
                </label>
              </section>
            )}

            {FEATURE_DELEGATION && (
              <section className="setting">
                <SettingInfo title="Déléguer mes droits">
                  Autorise un autre membre à réserver/annuler en ton nom pendant une durée
                  limitée (ex. il gère les résas d'une soirée à ta place pendant que tu es
                  indisponible). La réservation reste sous ton compte ResaMania ; on trace
                  qui a agi.
                </SettingInfo>
                {outgoingDelegation ? (
                  <div className="delegation-active">
                    <p className="tiny">
                      Délégué à <strong>{outgoingDelegation.delegateName}</strong> jusqu'au{" "}
                      {new Date(outgoingDelegation.expiresAt).toLocaleString("fr-FR", {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                      .
                    </p>
                    <button
                      className="secondary"
                      onClick={revokeDelegation}
                      disabled={delegating}
                    >
                      {delegating ? "…" : "Révoquer"}
                    </button>
                  </div>
                ) : delegateMembers === null ? (
                  <p className="muted tiny">Chargement…</p>
                ) : delegateMembers.length === 0 ? (
                  <p className="muted tiny">Aucun autre membre disponible pour l'instant.</p>
                ) : (
                  <div className="delegation-form">
                    <select
                      value={pickedDelegate}
                      onChange={(e) => setPickedDelegate(e.target.value)}
                      aria-label="Choisir un délégué"
                    >
                      <option value="">— Choisir un membre —</option>
                      {delegateMembers.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                    <select
                      value={pickedHours}
                      onChange={(e) => setPickedHours(Number(e.target.value))}
                      aria-label="Durée de la délégation"
                    >
                      {DELEGATION_DURATIONS.map((d) => (
                        <option key={d.hours} value={d.hours}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                    <button onClick={createDelegation} disabled={delegating || !pickedDelegate}>
                      {delegating ? "…" : "Déléguer"}
                    </button>
                  </div>
                )}
              </section>
            )}

            <section className="setting">
              <h4>Un commentaire ?</h4>
              <p className="muted tiny">
                Une question, une idée, un bug ? Écris-le ici, ça m'est envoyé par e-mail.
              </p>
              <textarea
                className="comment-field"
                value={comment}
                maxLength={COMMENT_MAX}
                rows={3}
                placeholder="Ton message…"
                onChange={(e) => setComment(e.target.value)}
              />
              <div
                className="muted tiny"
                style={{ textAlign: "right" }}
                aria-live="polite"
              >
                {comment.length} / {COMMENT_MAX}
              </div>
              <button onClick={sendComment} disabled={sending || !comment.trim()}>
                {sending ? "Envoi…" : "Envoyer"}
              </button>
            </section>

            <div className="modal-actions">
              <button className="secondary" onClick={() => setOpen(false)}>
                Fermer
              </button>
            </div>
        </Dialog>
      )}
    </>
  );
}

// --- Toasts & confirmation (remplacent alert()/confirm() natifs, moches sur mobile) ----
type ToastType = "ok" | "err" | "info";
type Toast = { id: number; type: ToastType; msg: string };
const TOAST_ICON: Record<ToastType, string> = { ok: "✅", err: "⚠️", info: "ℹ️" };
function Toasts({ items }: { items: Toast[] }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.type}`}>
          {TOAST_ICON[t.type]} {t.msg}
        </div>
      ))}
    </div>
  );
}

type ConfirmOpts = {
  title: string;
  body: string;
  lines?: string[]; // si fourni, affiché en liste (une réservation par ligne) sous le body
  confirmLabel: string;
  danger?: boolean;
};
type ConfirmState = (ConfirmOpts & { resolve: (v: boolean) => void }) | null;
function ConfirmDialog({
  state,
  onResolve,
}: {
  state: ConfirmState;
  onResolve: (v: boolean) => void;
}) {
  if (!state) return null;
  return (
    <Dialog onClose={() => onResolve(false)} label={state.title}>
      <h3>{state.title}</h3>
      <p>{state.body}</p>
      {state.lines && state.lines.length > 0 && (
        <ul className="confirm-lines">
          {state.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      <div className="modal-actions">
        <button className="secondary" onClick={() => onResolve(false)}>
          Retour
        </button>
        <button
          className={state.danger ? "danger" : ""}
          onClick={() => onResolve(true)}
        >
          {state.confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

// Icône « partager »
function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.6" y1="13.5" x2="15.4" y2="17.5" />
      <line x1="15.4" y1="6.5" x2="8.6" y2="10.5" />
    </svg>
  );
}
// Icône « rafraîchir »
function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15" />
    </svg>
  );
}

// Icône « information » (cercle + i) — ouvre la note de confidentialité.
function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <line x1="12" y1="8" x2="12" y2="8" />
    </svg>
  );
}

// Pied de page : petite note « Confidentialité & données » (obligation d'information RGPD).
// Placée en bas de page (convention pour ce type de mention), sur l'écran de connexion
// comme sur l'appli. La modale réutilise le style .modal existant.
function PrivacyNotice() {
  const [open, setOpen] = useState(false);
  return (
    <footer className="app-footer">
      <button
        type="button"
        className="footer-info"
        onClick={() => setOpen(true)}
        aria-label="Confidentialité et données"
        title="Confidentialité et données"
      >
        <InfoIcon />
        <span>Confidentialité &amp; données</span>
      </button>
      {open && (
        <Dialog onClose={() => setOpen(false)} label="Confidentialité et données" className="privacy">
            <h3>Confidentialité &amp; données</h3>
            <div className="privacy-body">
              <p>
                Application indépendante, <strong>non affiliée à ResaMania /
                Stadline ni au club</strong>. Elle facilite la réservation des
                terrains de squash du Complexe de Bures via ton compte
                ResaMania.
              </p>
              <p>
                Ton mot de passe ResaMania n'est <strong>jamais conservé</strong>.
                Il ne sert qu'au moment de la connexion, pour t'authentifier
                auprès de ResaMania. L'appli ne garde ensuite qu'un jeton de
                session <strong>chiffré</strong> (AES-256-GCM), pour t'éviter de
                te reconnecter à chaque visite.
              </p>
              <p>
                Si tu te connectes via cette appli, sont enregistrés : ton nom
                (fourni par ResaMania), ton adresse e-mail, un éventuel
                pseudonyme que tu choisis, les réservations faites via l'appli,
                et ton adresse IP de connexion (uniquement pour limiter les
                tentatives abusives).
              </p>
              <p>
                Ces données servent seulement à te connecter, afficher et gérer
                les réservations, et protéger le service contre les abus. Elles
                ne sont ni revendues ni transmises à des tiers (hormis
                ResaMania, le service que tu utilises déjà).
              </p>
              {FEATURE_DIRECTORY && (
                <p>
                  <strong>Annuaire des membres.</strong> Pour faciliter l'entraide
                  entre joueurs, ton nom (ou pseudonyme) est visible dans un annuaire
                  interne réservé aux membres connectés. <strong>Aucune autre donnée
                  n'y figure</strong> (ni e-mail, ni réservations). Tu peux t'en retirer
                  à tout moment depuis ⚙️ Paramètres › « Annuaire des membres ».
                </p>
              )}
              {FEATURE_RANKING && (
                <p>
                  <strong>Classement fédéral.</strong> À côté de ton nom peut s'afficher ton
                  classement de squash, <strong>issu de squashnet.fr</strong> (le classement
                  officiel FFSquash, une <strong>source publique</strong>). Il est rapproché de
                  ton nom uniquement si tu figures dans l'annuaire, et sert aussi à pré-remplir
                  l'ordre des joueurs lors de la création d'un tournoi. Retire-toi de l'annuaire
                  pour ne plus l'afficher.
                </p>
              )}
              <p>
                <strong>Liste d'attente &amp; notifications.</strong> Sur un créneau
                complet, tu peux demander à être prévenu qu'un terrain se libère : on
                enregistre alors le créneau visé et, si tu l'autorises, un abonnement aux
                notifications de ton navigateur (pour t'envoyer l'alerte). Le
                <strong> nombre de membres en attente</strong> et <strong>ta position</strong>
                sont affichés aux membres connectés — <strong>jamais le nom</strong> des
                inscrits. Tu peux quitter une liste d'attente à tout moment (🕒 « Ma liste
                d'attente »).
              </p>
              {FEATURE_TRICOUNT && (
                <p>
                  <strong>Partage de frais (« Frais »).</strong> Si le groupe utilise cette
                  vue, les dépenses saisies (libellé, montant, date, qui a payé et pour qui),
                  les remboursements et les éventuels messages sont visibles par
                  <strong> tous les membres connectés</strong>. Pour lever toute ambiguïté sur
                  les comptes, cette vue affiche le <strong>nom réel</strong> des membres (jamais
                  le pseudonyme) et donc <strong>qui doit combien à qui</strong>. N'y saisis que
                  des dépenses que tu acceptes de partager avec le groupe.
                </p>
              )}
              {FEATURE_TOURNAMENT && (
                <p>
                  <strong>Tournois.</strong> Un tournoi enregistre la liste des participants
                  (membres et <strong>prénoms d'invités hors asso</strong> que tu ajoutes), les
                  matchs et leurs scores. Ces informations sont visibles par
                  <strong> tous les membres connectés</strong>. N'ajoute un invité que si tu es
                  d'accord pour que son prénom apparaisse dans le tournoi.
                </p>
              )}
              <p>
                Hébergement en Union européenne : application sur Vercel, base
                de données sur Neon.
              </p>
              <p>
                Tu peux demander à consulter ou supprimer tes données à tout
                moment — la déconnexion efface déjà ta session. Une question, ou
                envie d'exercer ces droits ? Une fois connecté, écris-nous
                depuis ⚙️ Paramètres › « Un commentaire&nbsp;? ».
              </p>
            </div>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setOpen(false)}>
                Fermer
              </button>
            </div>
        </Dialog>
      )}
    </footer>
  );
}

// Bouton « partager » : Web Share natif (mobile) sinon copie du lien.
// Partage : notre PROPRE QR code (logo raquette au centre + « Squash de l'Yvette »),
// scannable/partageable/téléchargeable. Contrairement au QR du menu natif du téléphone,
// on maîtrise ici l'icône centrale et le texte.
function ShareButton({ toast }: { toast: (type: ToastType, msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // URL racine de l'appli (sans les filtres de la vue courante) → QR stable.
  const appUrl = () =>
    typeof window !== "undefined" ? `${window.location.origin}/` : "";

  useEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    (async () => {
      // 1) QR dans un canvas temporaire (correction d'erreurs « H » → logo central OK).
      const qr = document.createElement("canvas");
      await QRCode.toCanvas(qr, appUrl(), {
        width: 320,
        margin: 2,
        errorCorrectionLevel: "H",
        color: { dark: "#0f1115", light: "#ffffff" },
      });
      if (cancelled) return;

      // 2) Composition finale : QR + légende (fond toujours blanc pour rester scannable).
      const W = 320;
      const H = 372;
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(qr, 0, 0, 320, 320);
      ctx.fillStyle = "#0f1115";
      ctx.textAlign = "center";
      ctx.font = "600 20px system-ui, -apple-system, sans-serif";
      ctx.fillText("Squash de l'Yvette", W / 2, 352);

      // 3) Logo raquette au centre, sur une pastille blanche (préserve la lisibilité du QR).
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        const s = 86; // taille du logo central (QR en correction « H » → reste scannable)
        const x = (320 - s) / 2;
        const y = (320 - s) / 2;
        const pad = 8;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x - pad, y - pad, s + pad * 2, s + pad * 2);
        ctx.drawImage(img, x, y, s, s);
      };
      img.src = "/logo_squash.jpeg";
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(appUrl());
      toast("ok", "Lien copié ✅");
    } catch {
      toast("err", "Copie impossible");
    }
  };

  // Partage l'IMAGE du QR (menu natif si dispo), sinon la télécharge.
  const shareQr = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob(async (blob) => {
      if (!blob) return;
      const file = new File([blob], "squash-yvette-qr.png", { type: "image/png" });
      try {
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({
            files: [file],
            title: "Squash de l'Yvette",
            text: "Réserve un terrain de squash 🎾",
          });
        } else {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "squash-yvette-qr.png";
          a.click();
          URL.revokeObjectURL(a.href);
          toast("ok", "QR code téléchargé");
        }
      } catch {
        /* partage annulé par l'utilisateur */
      }
    }, "image/png");
  };

  return (
    <>
      <button
        className="secondary icon-btn"
        onClick={() => setOpen(true)}
        aria-label="Partager l'appli"
        title="Partager l'appli"
      >
        <ShareIcon />
      </button>
      {open && (
        <Dialog onClose={() => setOpen(false)} label="Partager l'appli" className="share">
            <h3>Partager l'appli</h3>
            <p className="muted tiny">
              Scanne ce QR code pour ouvrir l'appli, ou copie le lien.
            </p>
            <div className="qr-wrap">
              <canvas ref={canvasRef} className="qr-canvas" aria-label="QR code de l'appli" />
            </div>
            <div className="share-actions">
              <button onClick={shareQr}>Partager le QR</button>
              <button className="secondary" onClick={copyLink}>
                Copier le lien
              </button>
            </div>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setOpen(false)}>
                Fermer
              </button>
            </div>
        </Dialog>
      )}
    </>
  );
}

// Squelette de chargement (à la place du texte « Chargement… »)
function Skeleton() {
  return (
    <div className="grid-wrap skel" aria-hidden="true">
      {Array.from({ length: 8 }).map((_, i) => (
        <div className="skel-row" key={i}>
          <span className="skel-cell time" />
          <span className="skel-cell" />
          <span className="skel-cell" />
        </div>
      ))}
    </div>
  );
}

// État vide « présentable » (petit visuel + message) plutôt qu'un simple texte gris.
function EmptyState({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="empty">
      <span className="empty-icon" aria-hidden="true">{icon}</span>
      <p>{text}</p>
    </div>
  );
}

interface JournalEntry {
  id: string;
  displayName: string;
  courtName: string;
  startsAt: string;
  endsAt: string;
  mine: boolean;
}

// Icône calendrier (déclencheur du sélecteur de date natif).
function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M3 9h18M8 2v4M16 2v4" />
    </svg>
  );
}

// Icône « réserver plusieurs créneaux » (calendrier + coche).
function MultiSelectIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 11V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h6" />
      <path d="M3 9h18M8 2v4M16 2v4" />
      <path d="M15 18l2 2 4-4" />
    </svg>
  );
}

// Légende des couleurs, repliée dans un petit popover ⓘ pour libérer une ligne à l'écran.
// (Réutilise le composant InfoIcon défini plus haut pour la note de confidentialité.)
function LegendInfo() {
  const [open, setOpen] = useState(false);
  return (
    <span className="legend-info">
      <button
        type="button"
        className="secondary icon-btn"
        aria-label="Légende des couleurs"
        aria-expanded={open}
        title="Légende"
        onClick={() => setOpen((o) => !o)}
      >
        <InfoIcon />
      </button>
      {open && (
        <>
          <div className="legend-backdrop" onClick={() => setOpen(false)} />
          <div className="legend-pop" role="dialog" aria-label="Légende des couleurs">
            <span><i style={{ background: "var(--free)" }} /> Libre</span>
            <span><i style={{ background: "var(--group)" }} /> Réservé (asso)</span>
            <span><i style={{ background: "var(--booked)" }} /> Réservé (autre)</span>
          </div>
        </>
      )}
    </span>
  );
}

interface AlertItem {
  id: string;
  date: string; // YYYY-MM-DD
  hm: string; // HH:MM
  count?: number; // total d'inscrits en liste d'attente sur ce créneau
  position?: number; // mon rang (1 = 1ᵉʳ inscrit)
}

export default function Home() {
  const [me, setMe] = useState<string | null | undefined>(undefined); // undefined = chargement
  const [myHandle, setMyHandle] = useState<string>(""); // token créneau (pseudo tronqué / Tho.P)
  const [nickname, setNickname] = useState<string | null>(null); // pseudonyme choisi
  const [listed, setListed] = useState(true); // visibilité annuaire (idée 6, opt-out)
  const [canBook, setCanBook] = useState(true); // false = session « email seul » (lecture seule)
  const [date, setDate] = useState<string>(() => defaultOpenDate());
  const [planning, setPlanning] = useState<PlanningDay | null>(null);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState<Range>("all");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmState, setConfirmState] = useState<ConfirmState>(null);
  const [view, setView] = useState<"day" | "week" | "money" | "tourney">("day");
  // Vues « plein écran » sans le chrome planning (Frais, Tournoi).
  const isSpecial = view === "money" || view === "tourney";
  const [week, setWeek] = useState<{ date: string; planning: PlanningDay }[]>([]);
  const [busy, setBusy] = useState(false);
  // Mode « sélection multiple » (piloté depuis la barre de vue, appliqué dans la grille
  // affichée). Remonté ici pour que le bouton bascule vive dans la barre d'outils compacte.
  const [selMode, setSelMode] = useState(false);
  // Hydratation : on ne charge la donnée et on n'écrit l'URL/localStorage qu'après avoir lu
  // l'état initial (URL puis localStorage). Évite un double chargement au premier rendu.
  const [hydrated, setHydrated] = useState(false);
  const lastFocusRef = useRef(0);
  const dateInputRef = useRef<HTMLInputElement>(null);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [alertsOpen, setAlertsOpen] = useState(false);
  // Liste d'attente (idée D) : nombre d'inscrits par créneau ("YYYY-MM-DD|HH:MM" -> n),
  // pour la plage affichée. Alimenté par /api/alerts/counts, montré à tous.
  const [waitCounts, setWaitCounts] = useState<Record<string, number>>({});
  // Badge € : nombre de tricounts où JE dois de l'argent et où les remboursements
  // sont ouverts (action possible « rembourser »). Alimenté au chargement/focus et,
  // en direct, par le composant Tricount quand la vue Frais est ouverte.
  const [triOwed, setTriOwed] = useState(0);
  // Délégation (idée 4) : délégation entrante active (si un autre membre m'a délégué ses
  // droits) + pour qui j'agis actuellement (null = moi-même).
  const [incomingDelegation, setIncomingDelegation] = useState<{
    delegatorId: string;
    delegatorName: string;
    expiresAt: string;
  } | null>(null);
  const [actingAsId, setActingAsId] = useState<string | null>(null);
  // Bandeau « on t'a délégué des droits » : masquable, mais ré-affiché si la délégation
  // change (nouveau délégant ou nouvelle échéance) via une clé identité.
  const [delegBannerDismissed, setDelegBannerDismissed] = useState<string | null>(null);
  const today = toISODate(new Date());
  // Notifications disponibles seulement une fois monté (évite un décalage d'hydratation)
  // ET si le navigateur les supporte ET si les clés VAPID sont configurées côté serveur.
  const canNotify = hydrated && pushSupported() && pushEnabledOnServer();

  // Ouvre le calendrier natif depuis le libellé de date (champ input masqué).
  const openDatePicker = () => {
    const el = dateInputRef.current;
    if (!el) return;
    try {
      el.showPicker?.();
    } catch {
      el.focus(); // showPicker non supporté / hors geste utilisateur
    }
  };

  const toast = useCallback((type: ToastType, msg: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, type, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  const askConfirm = useCallback(
    (opts: ConfirmOpts) =>
      new Promise<boolean>((resolve) => setConfirmState({ ...opts, resolve })),
    [],
  );
  const resolveConfirm = (v: boolean) => {
    confirmState?.resolve(v);
    setConfirmState(null);
  };

  const checkMe = useCallback(async () => {
    const res = await fetch("/api/auth/me");
    if (res.ok) {
      const data = await res.json();
      setMe(data.displayName);
      setMyHandle(data.handle ?? "");
      setNickname(data.nickname ?? null);
      setListed(data.listed ?? true);
      setCanBook(data.canBook ?? true);
    } else {
      setMe(null);
      setMyHandle("");
      setNickname(null);
    }
  }, []);

  useEffect(() => {
    checkMe();
  }, [checkMe]);

  const loadAlerts = useCallback(async () => {
    const r = await fetch("/api/alerts");
    if (r.ok) setAlerts(await r.json());
  }, []);
  useEffect(() => {
    if (me && canNotify) loadAlerts();
  }, [me, canNotify, loadAlerts]);

  // Compteurs « N en attente » pour la plage [from, to] (jour : from==to).
  const loadWaitCounts = useCallback(async (from: string, to: string) => {
    const r = await fetch(`/api/alerts/counts?from=${from}&to=${to}`);
    if (r.ok) setWaitCounts(await r.json());
    else setWaitCounts({});
  }, []);

  // Compteur du badge € : tricounts où je dois de l'argent, remboursements ouverts.
  const loadTriOwed = useCallback(async () => {
    const r = await fetch("/api/tricount");
    if (!r.ok) return;
    const d = (await r.json()) as {
      me: string;
      tricounts: {
        ready: boolean;
        settled: boolean;
        balances: { userId: string; cents: number }[];
      }[];
    };
    const n = d.tricounts.filter(
      (t) =>
        t.ready &&
        !t.settled &&
        (t.balances.find((b) => b.userId === d.me)?.cents ?? 0) < 0,
    ).length;
    setTriOwed(n);
  }, []);
  useEffect(() => {
    if (me && FEATURE_TRICOUNT) loadTriOwed();
  }, [me, loadTriOwed]);

  // Délégation reçue (idée 4) : si un autre membre m'a délégué ses droits, je peux agir
  // « en son nom ». `actingAs` = pour qui j'agis actuellement (null = moi-même).
  const loadIncomingDelegation = useCallback(async () => {
    const r = await fetch("/api/delegations");
    if (!r.ok) {
      setIncomingDelegation(null);
      return;
    }
    const d = (await r.json()) as {
      incoming: { delegatorId: string; delegatorName: string; expiresAt: string } | null;
    };
    setIncomingDelegation(d.incoming);
  }, []);
  useEffect(() => {
    if (me && FEATURE_DELEGATION) loadIncomingDelegation();
  }, [me, loadIncomingDelegation]);
  // Sécurité : si la délégation sélectionnée n'est plus la délégation entrante active
  // (révoquée, expirée, remplacée), on retombe sur « moi-même ».
  useEffect(() => {
    if (actingAsId && incomingDelegation?.delegatorId !== actingAsId) setActingAsId(null);
  }, [actingAsId, incomingDelegation]);

  const load = useCallback(
    async (d: string) => {
      setLoading(true);
      setError(null);
      try {
        // Séquentiel à dessein : /api/planning réconcilie la base (résas annulées ailleurs),
        // puis /api/bookings lit un journal déjà à jour.
        const pr = await fetch(`/api/planning?date=${d}`);
        if (pr.status === 401) {
          setMe(null);
          return;
        }
        const pdata = await pr.json();
        if (!pr.ok) throw new Error(pdata.error ?? `Erreur ${pr.status}`);
        setPlanning(pdata);
        const jr = await fetch(`/api/bookings?date=${d}`);
        setJournal(jr.ok ? await jr.json() : []);
        loadWaitCounts(d, d);
      } catch (e) {
        setError((e as Error).message);
        setPlanning(null);
      } finally {
        setLoading(false);
      }
    },
    [loadWaitCounts],
  );

  const loadWeek = useCallback(async (d: string) => {
    setLoading(true);
    setError(null);
    try {
      // Un seul appel : /api/week renvoie les 7 jours (planning brut, sans réconciliation).
      const r = await fetch(`/api/week?date=${d}`);
      if (r.status === 401) {
        setMe(null);
        return;
      }
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `Erreur ${r.status}`);
      const wk = j as { date: string; planning: PlanningDay }[];
      setWeek(wk);
      if (wk.length) loadWaitCounts(wk[0].date, wk[wk.length - 1].date);
    } catch (e) {
      setError((e as Error).message);
      setWeek([]);
    } finally {
      setLoading(false);
    }
  }, [loadWaitCounts]);

  // Lecture de l'état initial : `view`/`range` depuis l'URL (sinon localStorage). La DATE
  // n'est volontairement PAS restaurée : l'app s'ouvre toujours sur le jour par défaut
  // (aujourd'hui, ou demain après 21 h — cf. defaultOpenDate), pas sur le dernier jour vu.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);

    const isView = (x: string | null): x is "day" | "week" | "money" | "tourney" =>
      x === "day" || x === "week" || x === "money" || x === "tourney";
    const vParam = p.get("view");
    const vLS = localStorage.getItem("view");
    let v = isView(vParam) ? vParam : isView(vLS) ? vLS : null;
    if (v === "money" && !FEATURE_TRICOUNT) v = "day"; // Frais désactivé : jamais cette vue
    if (v === "tourney" && !FEATURE_TOURNAMENT) v = "day"; // Tournoi désactivé
    if (v) setView(v);

    const rParam = p.get("range");
    const rLS = localStorage.getItem("range");
    const r = isRange(rParam) ? rParam : isRange(rLS) ? rLS : null;
    if (r) setRange(r);

    setHydrated(true);
  }, []);

  // Reflète l'état dans l'URL (partageable, survit au refresh) et le persiste.
  useEffect(() => {
    if (!hydrated) return;
    const p = new URLSearchParams();
    p.set("date", date);
    p.set("view", view);
    if (range !== "all") p.set("range", range);
    window.history.replaceState(null, "", `${window.location.pathname}?${p.toString()}`);
    localStorage.setItem("view", view);
    localStorage.setItem("range", range);
  }, [hydrated, date, view, range]);

  useEffect(() => {
    if (!me || !hydrated) return;
    if (view === "money" || view === "tourney") return; // ces vues chargent leurs propres données
    if (view === "week") loadWeek(date);
    else load(date);
  }, [me, hydrated, date, view, load, loadWeek]);

  // On sort du mode « sélection multiple » dès qu'on change de vue ou de date,
  // pour ne pas traîner une sélection devenue hors contexte.
  useEffect(() => {
    setSelMode(false);
  }, [view, date]);

  const reload = useCallback(() => {
    if (view === "money" || view === "tourney") return; // ces vues se rechargent seules
    if (view === "week") loadWeek(date);
    else load(date);
  }, [view, date, load, loadWeek]);

  // Rafraîchit au retour sur l'onglet (throttle 15 s) : le planning peut avoir bougé
  // pendant l'absence (un autre membre a réservé). Évite de réserver un créneau déjà pris.
  useEffect(() => {
    if (!me) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastFocusRef.current < 15000) return;
      lastFocusRef.current = now;
      reload();
      if (FEATURE_TRICOUNT) loadTriOwed(); // le badge € peut avoir changé (validation ailleurs)
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [me, reload, loadTriOwed]);

  const pickDay = (d: string) => {
    setView("day");
    setDate(d);
  };

  // Détecte une session expirée (401) et renvoie vers le login proprement.
  const handleExpired = (status: number): boolean => {
    if (status === 401) {
      setMe(null);
      toast("err", "Session expirée — reconnecte-toi.");
      return true;
    }
    return false;
  };

  const onBook = async (slot: Slot) => {
    if (busy || confirmState) return; // anti double-clic / double-modale
    if (!canBook) {
      toast(
        "info",
        "Réservation possible seulement via ResaMania. Ici tu peux te mettre « +1 » sur un créneau déjà réservé.",
      );
      return;
    }
    // Blocage « même créneau » : impossible de réserver 2 terrains au même horaire
    // (ResaMania le refuse). On prévient tout de suite si on a déjà une résa à cette heure.
    const clash = planning?.slots.find((s) => s.startsAt === slot.startsAt && s.mine);
    if (clash) {
      toast("info", `Tu joues déjà sur ${clash.courtName} à cet horaire — un seul terrain à la fois.`);
      return;
    }
    const ok = await askConfirm({
      title: "Réserver ce créneau ?",
      body: `${slot.courtName} — ${fmtTime(slot.startsAt)} le ${prettyDate(slot.startsAt.slice(0, 10))}`,
      confirmLabel: "Réserver",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch("/api/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          classEventId: slot.id,
          courtName: slot.courtName,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          onBehalfOf: actingAsId ?? undefined,
        }),
      });
      if (handleExpired(res.status)) return;
      const data = await res.json();
      if (!res.ok) {
        // Conflit « même créneau » : notif d'information plutôt qu'une erreur.
        if (data.code === "overlap") {
          toast("info", data.error);
          return;
        }
        throw new Error(data.error ?? `Erreur ${res.status}`);
      }
      toast("ok", "Réservation confirmée");
      reload();
    } catch (e) {
      toast("err", "Réservation impossible : " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onCancel = async (b: JournalEntry) => {
    if (busy || confirmState) return;
    const ok = await askConfirm({
      title: "Annuler la réservation ?",
      body: `${b.courtName} — ${fmtTime(b.startsAt)} le ${prettyDate(date)}`,
      confirmLabel: "Annuler la résa",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/bookings/${b.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ onBehalfOf: actingAsId ?? undefined }),
      });
      if (handleExpired(res.status)) return;
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);
      toast("ok", "Réservation annulée");
      reload();
    } catch (e) {
      toast("err", "Annulation impossible : " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Annulation directement depuis la grille (clic sur son créneau « ★ »).
  const onCancelMine = async (slot: Slot) => {
    if (busy || confirmState) return;
    const ok = await askConfirm({
      title: "Annuler ta réservation ?",
      body: `${slot.courtName} — ${fmtTime(slot.startsAt)} le ${prettyDate(slot.startsAt.slice(0, 10))}`,
      confirmLabel: "Annuler la résa",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch("/api/cancel-slot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classEventId: slot.id, onBehalfOf: actingAsId ?? undefined }),
      });
      if (handleExpired(res.status)) return;
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);
      toast("ok", "Réservation annulée");
      reload();
    } catch (e) {
      toast("err", "Annulation impossible : " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Signale/retire sa présence sur le créneau d'un autre membre. Pas de confirmation.
  // Mise à jour optimiste (ton prénom apparaît/disparaît aussitôt), puis re-sync si échec.
  const onTogglePresence = async (slot: Slot) => {
    if (!me) return;
    // Diminutif du joueur courant (Tho.P) : DOIT correspondre à ce que renvoie le
    // serveur dans `attendees`, sinon l'ajout optimiste laisse un doublon après re-sync.
    const myFirst = myHandle || me.split(" ")[0];
    const wasAttending = slot.iAmAttending ?? false;
    setPlanning((p) =>
      p
        ? {
            ...p,
            slots: p.slots.map((s) => {
              // Créneau ciblé : on bascule ma présence.
              if (s.id === slot.id) {
                const cur = s.attendees ?? [];
                return {
                  ...s,
                  attendees: wasAttending ? cur.filter((n) => n !== myFirst) : [...cur, myFirst],
                  iAmAttending: !wasAttending,
                };
              }
              // Ajout : je me retire d'un éventuel autre terrain au même horaire (exclusivité).
              if (!wasAttending && s.startsAt === slot.startsAt && s.iAmAttending) {
                return {
                  ...s,
                  attendees: (s.attendees ?? []).filter((n) => n !== myFirst),
                  iAmAttending: false,
                };
              }
              return s;
            }),
          }
        : p,
    );
    try {
      const res = await fetch("/api/presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classEventId: slot.id, startsAt: slot.startsAt }),
      });
      if (handleExpired(res.status)) return;
      if (!res.ok) throw new Error();
    } catch {
      toast("err", "Présence non enregistrée");
      reload(); // resynchronise l'état réel
    }
  };

  // Présence « +1 » depuis la vue semaine : POST direct puis rechargement de la semaine
  // (l'update optimiste de onTogglePresence cible le planning du jour, pas les 7 jours).
  const onTogglePresenceWeek = async (slot: Slot) => {
    if (!me) return;
    try {
      const res = await fetch("/api/presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classEventId: slot.id, startsAt: slot.startsAt }),
      });
      if (handleExpired(res.status)) return;
      if (!res.ok) throw new Error();
      reload();
    } catch {
      toast("err", "Présence non enregistrée");
    }
  };

  // Réservation groupée (vues jour et semaine) : un /api/book par créneau, en séquence, avec bilan.
  const onBookMany = async (slots: Slot[]) => {
    if (busy || confirmState || slots.length === 0) return;
    const MAX_LINES = 10;
    const lines = slots
      .slice(0, MAX_LINES)
      .map(
        (s) =>
          `${shortPretty(s.startsAt.slice(0, 10))} ${fmtTime(s.startsAt)} — ${s.courtName}`,
      );
    if (slots.length > MAX_LINES) lines.push(`… et ${slots.length - MAX_LINES} autre${slots.length - MAX_LINES > 1 ? "s" : ""}`);
    const ok = await askConfirm({
      title: `Réserver ${slots.length} créneau${slots.length > 1 ? "x" : ""} ?`,
      body: "Ces terrains seront réservés :",
      lines,
      confirmLabel: "Réserver",
    });
    if (!ok) return;
    setBusy(true);
    let done = 0;
    const fails: string[] = [];
    try {
      for (const slot of slots) {
        try {
          const res = await fetch("/api/book", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              classEventId: slot.id,
              courtName: slot.courtName,
              startsAt: slot.startsAt,
              endsAt: slot.endsAt,
              onBehalfOf: actingAsId ?? undefined,
            }),
          });
          if (res.status === 401) {
            handleExpired(401);
            return;
          }
          const data = await res.json().catch(() => ({}));
          if (res.ok) done++;
          else
            fails.push(
              `${shortPretty(slot.startsAt.slice(0, 10))} ${fmtTime(slot.startsAt)} : ${data.error ?? res.status}`,
            );
        } catch {
          fails.push(`${shortPretty(slot.startsAt.slice(0, 10))} ${fmtTime(slot.startsAt)} : réseau`);
        }
      }
    } finally {
      setBusy(false);
    }
    if (done > 0) {
      toast(
        fails.length ? "info" : "ok",
        `${done} réservation${done > 1 ? "s" : ""} confirmée${done > 1 ? "s" : ""}` +
          (fails.length ? ` · ${fails.length} échec${fails.length > 1 ? "s" : ""}` : ""),
      );
    } else {
      toast("err", "Aucune réservation : " + (fails[0] ?? "échec"));
    }
    reload();
  };

  // Rafraîchit les compteurs « N en attente » pour la plage actuellement affichée.
  const refreshWaitCounts = useCallback(() => {
    if (view === "week" && week.length) {
      loadWaitCounts(week[0].date, week[week.length - 1].date);
    } else {
      loadWaitCounts(date, date);
    }
  }, [view, week, date, loadWaitCounts]);

  // Liste d'attente (idée D) : s'inscrire pour être prévenu qu'un terrain se libère sur
  // un créneau COMPLET. La résa reste manuelle (notif push quand ça se libère).
  const onWatch = async (slot: Slot) => {
    if (busy || confirmState) return;
    if (!canNotify) {
      toast("err", "Notifications indisponibles sur cet appareil.");
      return;
    }
    const day = slot.startsAt.slice(0, 10);
    const hm = slot.startsAt.slice(11, 16);
    const ok = await askConfirm({
      title: "Rejoindre la liste d'attente ?",
      body: `${fmtTime(slot.startsAt)} le ${prettyDate(day)} — on te notifie dès qu'un terrain se libère à cet horaire (réservation manuelle).`,
      confirmLabel: "M'inscrire 🕒",
    });
    if (!ok) return;
    const subscribed = await ensurePushSubscribed();
    if (!subscribed) {
      toast("err", "Autorise les notifications pour recevoir l'alerte.");
      return;
    }
    try {
      const res = await fetch("/api/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: day, hm }),
      });
      if (handleExpired(res.status)) return;
      if (!res.ok) throw new Error();
      toast("ok", "Inscrit en liste d'attente 🕒");
      loadAlerts();
      refreshWaitCounts();
    } catch {
      toast("err", "Impossible de rejoindre la liste d'attente.");
    }
  };

  const cancelAlert = async (id: string) => {
    setAlerts((a) => a.filter((x) => x.id !== id)); // retrait optimiste
    await fetch(`/api/alerts/${id}`, { method: "DELETE" }).catch(() => {});
    loadAlerts();
    refreshWaitCounts();
  };

  // Retrait de la liste d'attente depuis la grille (par créneau, pas par id d'alerte).
  const onUnwatch = (date: string, hm: string) => {
    const a = alerts.find((x) => x.date === date && x.hm === hm);
    if (a) cancelAlert(a.id);
  };

  // Compteur « N en attente » et mon rang pour un créneau (pour les grilles + modale).
  const waitCountFor = (date: string, hm: string) => waitCounts[`${date}|${hm}`] ?? 0;
  const myWaitFor = (date: string, hm: string) =>
    alerts.find((a) => a.date === date && a.hm === hm) ?? null;

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setMe(null);
    setPlanning(null);
  };

  if (me === undefined) {
    return <main><p>Chargement…</p></main>;
  }

  if (me === null) {
    return <LoginScreen onLoggedIn={checkMe} />;
  }

  return (
    <main>
      <header className="app">
        <div className="app-top">
          <div className="brand">
            <h1>
              <img
                src="/logo_squash.jpeg"
                alt="Squash de l'Yvette"
                className="logo-mark"
              />
              <span className="brand-title" aria-hidden="true">
                Squash de l'Yvette
              </span>
            </h1>
          </div>
          <div className="actions">
            {FEATURE_DELEGATION && incomingDelegation && (
              <select
                className="acting-as-select"
                value={actingAsId ?? ""}
                onChange={(e) => setActingAsId(e.target.value || null)}
                aria-label="Réserver pour"
                title="Réserver pour"
              >
                <option value="">Pour moi</option>
                <option value={incomingDelegation.delegatorId}>
                  Pour {incomingDelegation.delegatorName}
                </option>
              </select>
            )}
            {canNotify && (
              <button
                className="secondary icon-btn alerts-btn"
                onClick={() => setAlertsOpen(true)}
                aria-label={`Ma liste d'attente${alerts.length ? ` (${alerts.length})` : ""}`}
                title="Ma liste d'attente"
              >
                <BellIcon />
                {alerts.length > 0 && <span className="badge">{alerts.length}</span>}
              </button>
            )}
            <ShareButton toast={toast} />
            <DirectoryButton toast={toast} />
            <SettingsButton
              nickname={nickname}
              listed={listed}
              onProfileSaved={checkMe}
              toast={toast}
            />
            {/* Bouton Frais : actif si le flag est ON ; sinon affiché grisé (désactivé)
                avec un tooltip « en cours de développement » (feature bientôt dispo). */}
            <button
              className={
                "secondary icon-btn money-btn" +
                (view === "money" ? " active" : "") +
                (FEATURE_TRICOUNT ? "" : " coming-soon")
              }
              onClick={() =>
                FEATURE_TRICOUNT && setView(view === "money" ? "day" : "money")
              }
              disabled={!FEATURE_TRICOUNT}
              aria-label={
                FEATURE_TRICOUNT
                  ? `Frais partagés (tricount)${triOwed ? ` — ${triOwed} à rembourser` : ""}`
                  : "Frais partagés — en cours de développement"
              }
              aria-pressed={view === "money"}
              title={FEATURE_TRICOUNT ? "Frais partagés" : "🚧 En cours de développement"}
            >
              <EuroIcon />
              {FEATURE_TRICOUNT && triOwed > 0 && <span className="badge">{triOwed}</span>}
            </button>
            {/* Bouton Tournoi : actif si le flag est ON, sinon grisé « en dév ». */}
            <button
              className={
                "secondary icon-btn tourney-btn" +
                (view === "tourney" ? " active" : "") +
                (FEATURE_TOURNAMENT ? "" : " coming-soon")
              }
              onClick={() =>
                FEATURE_TOURNAMENT && setView(view === "tourney" ? "day" : "tourney")
              }
              disabled={!FEATURE_TOURNAMENT}
              aria-label={
                FEATURE_TOURNAMENT ? "Tournois" : "Tournois — en cours de développement"
              }
              aria-pressed={view === "tourney"}
              title={FEATURE_TOURNAMENT ? "Tournois" : "🚧 En cours de développement"}
            >
              <TrophyIcon />
            </button>
            <button
              className="secondary logout"
              onClick={logout}
              aria-label="Déconnexion"
              title="Déconnexion"
            >
              <LogoutIcon />
              <span className="label">Déconnexion</span>
            </button>
          </div>
        </div>
        {/* Sous-titre pleine largeur : accueil + lieu réunis sur une seule ligne
            (l'ancienne ligne « Bonjour » séparée est supprimée pour gagner de la place). */}
        <div className="sub">Bonjour {nickname || me.split(" ")[0]} 👋 · Le Complexe, Bures</div>
      </header>

      {FEATURE_DELEGATION &&
        incomingDelegation &&
        delegBannerDismissed !==
          `${incomingDelegation.delegatorId}|${incomingDelegation.expiresAt}` && (
          <div className="notice info deleg-banner" role="status">
            <span>
              🤝 <strong>{incomingDelegation.delegatorName}</strong> t'a délégué ses droits :
              tu peux réserver / annuler en son nom jusqu'au{" "}
              {new Date(incomingDelegation.expiresAt).toLocaleString("fr-FR", {
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}
              . Sélectionne « Pour {incomingDelegation.delegatorName} » en haut à droite pour
              agir en son nom.
            </span>
            <button
              type="button"
              className="deleg-banner-close"
              aria-label="Masquer ce message"
              onClick={() =>
                setDelegBannerDismissed(
                  `${incomingDelegation.delegatorId}|${incomingDelegation.expiresAt}`,
                )
              }
            >
              ✕
            </button>
          </div>
        )}

      {!canBook && (
        <div className="notice info readonly-note">
          🔒 <strong>Lecture seule</strong> (connexion par email) : réserver un terrain passe par
          ResaMania. Tu peux consulter le planning et te mettre « +1 » sur un créneau déjà réservé
          par un membre.
        </div>
      )}

      {/* Navigation de date : flèches + libellé (qui ouvre le calendrier natif) + pastille
          « Aujourd'hui » (toujours présente, inactive si on y est déjà), le tout sur UNE ligne. */}
      {!isSpecial && (
      <div className="toolbar">
        <button className="secondary nav" aria-label="Jour précédent" onClick={() => setDate(addDays(date, view === "week" ? -7 : -1))}>←</button>
        <button
          type="button"
          className="secondary datebtn"
          onClick={openDatePicker}
          title="Choisir une date"
          aria-label="Choisir une date"
        >
          <CalendarIcon />
          <span className="date">{view === "week" ? weekLabel(date) : shortPretty(date)}</span>
        </button>
        <button className="secondary nav" aria-label="Jour suivant" onClick={() => setDate(addDays(date, view === "week" ? 7 : 1))}>→</button>
        {/* Toujours présent (place fixe dans la barre) ; inactif quand on est déjà sur aujourd'hui. */}
        <button
          type="button"
          className="secondary today-chip"
          onClick={() => setDate(today)}
          disabled={date === today}
          aria-label="Revenir à aujourd'hui"
          title={date === today ? "Tu es déjà sur aujourd'hui" : "Revenir à aujourd'hui"}
        >
          Auj.
        </button>
        {/* Champ natif masqué : ouvert via showPicker() au clic sur le libellé de date. */}
        <input
          ref={dateInputRef}
          type="date"
          className="datepick-hidden"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          tabIndex={-1}
          aria-hidden="true"
        />
      </div>
      )}

      {/* Vue (Jour/Semaine) à gauche ; à droite les actions compactes en icônes :
          sélection multiple, légende (ⓘ) et rafraîchir. */}
      <div className="viewbar">
        <div className="viewtabs" role="group" aria-label="Vue">
          <button className={view === "day" ? "active" : ""} aria-pressed={view === "day"} onClick={() => setView("day")}>Jour</button>
          <button className={view === "week" ? "active" : ""} aria-pressed={view === "week"} onClick={() => setView("week")}>Semaine</button>
        </div>
        {!isSpecial && (
        <div className="viewbar-icons">
          <button
            type="button"
            className={"secondary icon-btn selbtn" + (selMode ? " active" : "")}
            aria-pressed={selMode}
            onClick={() => setSelMode((v) => !v)}
            title={selMode ? "Annuler la sélection" : "Réserver plusieurs créneaux"}
            aria-label={selMode ? "Annuler la sélection multiple" : "Réserver plusieurs créneaux"}
          >
            <MultiSelectIcon />
          </button>
          <LegendInfo />
          <button
            className={"secondary icon-btn refresh" + (loading ? " spin" : "")}
            onClick={reload}
            disabled={loading}
            aria-label="Rafraîchir"
            title="Rafraîchir"
          >
            <RefreshIcon />
          </button>
        </div>
        )}
      </div>

      {!isSpecial && (
      <div className="filters" role="group" aria-label="Plage horaire">
        {RANGES.map((r) => (
          <button
            key={r.key}
            className={range === r.key ? "active" : ""}
            aria-pressed={range === r.key}
            onClick={() => setRange(r.key)}
          >
            {r.label}
          </button>
        ))}
      </div>
      )}

      {view === "day" && planning?.cached && (
        <p className="muted tiny cache-note">
          🕒{" "}
          {planning.notice
            ? planning.notice
            : `Planning en cache — dernière mise à jour ${
                planning.cachedAt
                  ? new Date(planning.cachedAt).toLocaleString("fr-FR", {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "—"
              } par un membre connecté à ResaMania.`}
        </p>
      )}

      {/* Annonce discrète pour lecteurs d'écran (chargement / erreur). */}
      <p className="sr-only" role="status" aria-live="polite">
        {loading ? "Chargement du planning…" : error ? `Erreur : ${error}` : ""}
      </p>

      {error && !isSpecial && <div className="notice error" role="alert">⚠️ {error}</div>}

      {FEATURE_TRICOUNT && view === "money" && (
        <Tricount toast={toast} onExpired={handleExpired} onOwedChange={setTriOwed} />
      )}

      {FEATURE_TOURNAMENT && view === "tourney" && (
        <Tournament toast={toast} onExpired={handleExpired} />
      )}

      {isSpecial
        ? null
        : view === "day"
        ? planning
          ? (() => {
              const slots = planning.slots.filter((s) => inRange(s.startsAt, range));
              if (slots.length === 0) {
                return <EmptyState icon="🎾" text="Aucun créneau sur cette plage horaire." />;
              }
              return (
                <PlanningGrid
                  planning={{ ...planning, slots }}
                  onBook={onBook}
                  onCancelMine={onCancelMine}
                  onTogglePresence={onTogglePresence}
                  onBookMany={onBookMany}
                  selMode={selMode}
                  setSelMode={setSelMode}
                  onWatch={onWatch}
                  onUnwatch={onUnwatch}
                  canWatch={canNotify}
                  waitCountFor={waitCountFor}
                  myWaitFor={myWaitFor}
                />
              );
            })()
          : loading
            ? <Skeleton />
            : null
        : week.length
          ? <WeekGrid days={week} filter={(iso) => inRange(iso, range)} onPick={pickDay} onBook={onBook} onCancelMine={onCancelMine} onTogglePresence={onTogglePresenceWeek} onBookMany={onBookMany} selMode={selMode} setSelMode={setSelMode} onWatch={onWatch} onUnwatch={onUnwatch} canWatch={canNotify} waitCountFor={waitCountFor} myWaitFor={myWaitFor} />
          : loading
            ? <Skeleton />
            : null}

      {view === "day" && (
        <section className="journal">
          <h2>👥 Réservations des membres de l'asso — {prettyDate(date)}</h2>
          {journal.length === 0 ? (
            <EmptyState icon="👥" text="Aucun membre de l'asso n'a (encore) réservé ce jour-là." />
          ) : (
            <ul>
              {journal.map((b) => (
                <li key={b.id} className={b.mine ? "mine" : ""}>
                  <span>
                    <strong>{fmtTime(b.startsAt)}</strong> · {b.courtName} ·{" "}
                    {b.displayName} {b.mine && "(toi)"}
                  </span>
                  {b.mine && (
                    <span className="jrow-actions">
                      <button
                        type="button"
                        className="ics"
                        title="Ajouter à mon agenda (.ics, rappel 1 h avant)"
                        aria-label="Ajouter à mon agenda"
                        onClick={() => downloadIcs(b)}
                      >
                        📅
                      </button>
                      <button className="cancel" onClick={() => onCancel(b)}>
                        Annuler
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <PrivacyNotice />
      {alertsOpen && (
        <Dialog onClose={() => setAlertsOpen(false)} label="Ma liste d'attente">
            <h3>🕒 Ma liste d'attente</h3>
            {alerts.length === 0 ? (
              <p className="muted">
                Tu n'es sur aucune liste d'attente. Sur un créneau complet, touche
                l'horaire (vue Jour) ou la case (vue Semaine) pour être prévenu qu'un
                terrain se libère.
              </p>
            ) : (
              <ul className="alerts-list">
                {alerts.map((a) => (
                  <li key={a.id}>
                    <span>
                      {prettyDate(a.date)} · <strong>{a.hm}</strong>
                      {a.count != null && a.position != null && (
                        <span className="muted tiny">
                          {" "}
                          — {a.position}
                          <sup>e</sup> sur {a.count} en attente
                        </span>
                      )}
                    </span>
                    <button className="cancel" onClick={() => cancelAlert(a.id)}>
                      Retirer
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="modal-actions">
              <button className="secondary" onClick={() => setAlertsOpen(false)}>
                Fermer
              </button>
            </div>
        </Dialog>
      )}

      <Toasts items={toasts} />
      <ConfirmDialog state={confirmState} onResolve={resolveConfirm} />
    </main>
  );
}

// Icône « œil » (afficher/masquer le mot de passe). `off` = œil barré (masqué).
function EyeIcon({ off }: { off: boolean }) {
  const p = {
    viewBox: "0 0 24 24",
    width: 20,
    height: 20,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (off) {
    return (
      <svg {...p}>
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20C5 20 1 12 1 12a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
        <line x1="1" y1="1" x2="23" y2="23" />
      </svg>
    );
  }
  return (
    <svg {...p}>
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function LoginScreen({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [tab, setTab] = useState<"resa" | "email">("resa");
  // ResaMania
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  // Connexion par email (OTP)
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [codeSent, setCodeSent] = useState(false);

  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submitResa = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Connexion impossible");
      onLoggedIn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const requestCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setInfo(null);
    try {
      const res = await fetch("/api/auth/otp/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Envoi impossible");
      setCodeSent(true);
      setInfo(`Code envoyé à ${email}. Regarde tes mails (et les spams).`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/auth/otp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code, name: name.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Code invalide");
      onLoggedIn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const switchTab = (t: "resa" | "email") => {
    setTab(t);
    setErr(null);
    setInfo(null);
  };

  return (
    <main className="login">
      <h1 className="sr-only">Squash de l'Yvette</h1>
      <img src="/logo_squash.jpeg" alt="Squash de l'Yvette" className="logo-hero" />

      {/* Onglet « Par email » : actif si le flag est ON ; sinon affiché grisé (désactivé)
          avec un tooltip « en cours de développement ». Seule ResaMania reste utilisable. */}
      <div className="login-tabs" role="group" aria-label="Méthode de connexion">
        <button
          type="button"
          className={tab === "resa" ? "active" : "secondary"}
          aria-pressed={tab === "resa"}
          onClick={() => switchTab("resa")}
        >
          ResaMania
        </button>
        <button
          type="button"
          className={
            (tab === "email" ? "active" : "secondary") +
            (FEATURE_EMAIL_LOGIN ? "" : " coming-soon")
          }
          aria-pressed={tab === "email"}
          onClick={() => FEATURE_EMAIL_LOGIN && switchTab("email")}
          disabled={!FEATURE_EMAIL_LOGIN}
          title={FEATURE_EMAIL_LOGIN ? undefined : "🚧 En cours de développement"}
        >
          Par email
        </button>
      </div>

      {tab === "resa" || !FEATURE_EMAIL_LOGIN ? (
        <>
          <p className="muted">
            Connecte-toi avec ton compte ResaMania (Le Complexe Bures).
          </p>
          <form onSubmit={submitResa}>
            <input
              type="text"
              placeholder="Identifiant (email)"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
            />
            <div className="pwd-field">
              <input
                type={showPwd ? "text" : "password"}
                placeholder="Mot de passe"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
              <button
                type="button"
                className="pwd-toggle"
                onClick={() => setShowPwd((v) => !v)}
                aria-label={showPwd ? "Masquer le mot de passe" : "Afficher le mot de passe"}
                aria-pressed={showPwd}
                title={showPwd ? "Masquer le mot de passe" : "Afficher le mot de passe"}
              >
                <EyeIcon off={showPwd} />
              </button>
            </div>
            <button type="submit" disabled={busy}>
              {busy ? "Connexion…" : "Se connecter"}
            </button>
          </form>
          <p className="muted tiny">
            Ton mot de passe sert seulement à te connecter à ResaMania ; il n'est jamais
            conservé. L'appli mémorise uniquement que tu es connecté, de façon sécurisée.
          </p>
        </>
      ) : (
        <>
          <p className="muted">
            Pas d'accès ResaMania (suspendu, pas encore inscrit…) ? Connecte-toi par email.
            Utilise le <strong>même email que sur ResaMania</strong> pour retrouver ton
            historique le jour où tu t'y reconnecteras.
          </p>
          {!codeSent ? (
            <form onSubmit={requestCode}>
              <input
                type="email"
                placeholder="Ton email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
              <button type="submit" disabled={busy || !email.trim()}>
                {busy ? "Envoi…" : "Recevoir un code"}
              </button>
            </form>
          ) : (
            <form onSubmit={verifyCode}>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="Code à 6 chiffres"
                value={code}
                maxLength={6}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              />
              <input
                type="text"
                placeholder="Ton nom (si première connexion)"
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
              />
              <button type="submit" disabled={busy || code.length !== 6}>
                {busy ? "Vérification…" : "Se connecter"}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setCodeSent(false);
                  setCode("");
                  setInfo(null);
                  setErr(null);
                }}
                disabled={busy}
              >
                Changer d'email / renvoyer un code
              </button>
            </form>
          )}
          <p className="muted tiny">
            En connexion email, tu peux consulter le planning et le Tricount, mais pas réserver
            de terrain (ça reste sur ResaMania).
          </p>
        </>
      )}

      {info && <div className="notice info">{info}</div>}
      {err && <div className="notice error">⚠️ {err}</div>}
      <PrivacyNotice />
    </main>
  );
}
