"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { PlanningDay, Slot } from "@/lib/resamania/types";
import { PlanningGrid } from "@/components/PlanningGrid";
import { WeekGrid } from "@/components/WeekGrid";

function toISODate(d: Date): string {
  return d.toLocaleDateString("en-CA"); // YYYY-MM-DD local
}
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + n);
  return toISODate(d);
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
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

// --- Semaine -----------------------------------------------------------------
function mondayOf(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  const off = (d.getDay() + 6) % 7; // 0 = lundi
  d.setDate(d.getDate() - off);
  return toISODate(d);
}
function weekDates(date: string): string[] {
  const mon = mondayOf(date);
  return Array.from({ length: 7 }, (_, i) => addDays(mon, i));
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
// Minutes depuis minuit lues directement dans l'ISO (évite tout décalage de fuseau).
function slotMinutes(iso: string): number {
  const m = iso.match(/T(\d{2}):(\d{2})/);
  return m ? +m[1] * 60 + +m[2] : 0;
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

// Thème : bouton-icône qui cycle Système (suit l'OS) → Clair → Sombre. Persisté en localStorage.
type Theme = "system" | "light" | "dark";
const THEME_ORDER: Theme[] = ["system", "light", "dark"];
const THEME_LABEL: Record<Theme, string> = {
  system: "Système",
  light: "Clair",
  dark: "Sombre",
};
function applyTheme(t: Theme) {
  const el = document.documentElement;
  if (t === "light" || t === "dark") el.setAttribute("data-theme", t);
  else el.removeAttribute("data-theme"); // "system" → Pico suit prefers-color-scheme
}
function ThemeIcon({ theme }: { theme: Theme }) {
  const p = {
    width: 18,
    height: 18,
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
  return (
    <svg {...p}>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    const saved = (localStorage.getItem("theme") as Theme) || "system";
    setTheme(saved);
    applyTheme(saved);
  }, []);
  const cycle = () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
    setTheme(next);
    localStorage.setItem("theme", next);
    applyTheme(next);
  };
  return (
    <button
      className="secondary icon-btn"
      onClick={cycle}
      aria-label={`Thème : ${THEME_LABEL[theme]} (cliquer pour changer)`}
      title={`Thème : ${THEME_LABEL[theme]} — cliquer pour changer`}
    >
      <ThemeIcon theme={theme} />
    </button>
  );
}

// --- Toasts & confirmation (remplacent alert()/confirm() natifs, moches sur mobile) ----
type Toast = { id: number; type: "ok" | "err"; msg: string };
function Toasts({ items }: { items: Toast[] }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.type}`}>
          {t.type === "ok" ? "✅" : "⚠️"} {t.msg}
        </div>
      ))}
    </div>
  );
}

type ConfirmOpts = {
  title: string;
  body: string;
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
    <div className="modal-overlay" onClick={() => onResolve(false)}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{state.title}</h3>
        <p>{state.body}</p>
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
      </div>
    </div>
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

// Bouton « partager » : Web Share natif (mobile) sinon copie du lien.
function ShareButton({ onCopied }: { onCopied: () => void }) {
  const share = async () => {
    // URL complète (avec ?date=&view=&range=) → on partage exactement la vue affichée.
    const url = typeof window !== "undefined" ? window.location.href : "";
    try {
      if (navigator.share) {
        await navigator.share({
          title: "Squash de l'Yvette",
          text: "Réserve un terrain de squash 🎾",
          url,
        });
      } else {
        await navigator.clipboard.writeText(url);
        onCopied();
      }
    } catch {
      /* partage annulé par l'utilisateur */
    }
  };
  return (
    <button className="secondary icon-btn" onClick={share} aria-label="Partager l'appli" title="Partager l'appli">
      <ShareIcon />
    </button>
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

export default function Home() {
  const [me, setMe] = useState<string | null | undefined>(undefined); // undefined = chargement
  const [date, setDate] = useState<string>(() => toISODate(new Date()));
  const [planning, setPlanning] = useState<PlanningDay | null>(null);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState<Range>("all");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmState, setConfirmState] = useState<ConfirmState>(null);
  const [view, setView] = useState<"day" | "week">("day");
  const [week, setWeek] = useState<{ date: string; planning: PlanningDay }[]>([]);
  const [busy, setBusy] = useState(false);
  // Hydratation : on ne charge la donnée et on n'écrit l'URL/localStorage qu'après avoir lu
  // l'état initial (URL puis localStorage). Évite un double chargement au premier rendu.
  const [hydrated, setHydrated] = useState(false);
  const lastFocusRef = useRef(0);
  const today = toISODate(new Date());

  const toast = useCallback((type: "ok" | "err", msg: string) => {
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
    setMe(res.ok ? (await res.json()).displayName : null);
  }, []);

  useEffect(() => {
    checkMe();
  }, [checkMe]);

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
      } catch (e) {
        setError((e as Error).message);
        setPlanning(null);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const loadWeek = useCallback(async (d: string) => {
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.all(
        weekDates(d).map(async (dd) => {
          const r = await fetch(`/api/planning?date=${dd}`);
          if (r.status === 401) throw new Error("__401__");
          const j = await r.json();
          if (!r.ok) throw new Error(j.error ?? `Erreur ${r.status}`);
          return { date: dd, planning: j as PlanningDay };
        }),
      );
      setWeek(results);
    } catch (e) {
      if ((e as Error).message === "__401__") {
        setMe(null);
        return;
      }
      setError((e as Error).message);
      setWeek([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Lecture de l'état initial : URL (?date=&view=&range=) prioritaire, sinon localStorage.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const d = p.get("date");
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) setDate(d);

    const vParam = p.get("view");
    const vLS = localStorage.getItem("view");
    const v =
      vParam === "week" || vParam === "day"
        ? vParam
        : vLS === "week" || vLS === "day"
          ? vLS
          : null;
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
    if (view === "week") loadWeek(date);
    else load(date);
  }, [me, hydrated, date, view, load, loadWeek]);

  const reload = useCallback(
    () => (view === "week" ? loadWeek(date) : load(date)),
    [view, date, load, loadWeek],
  );

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
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [me, reload]);

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
        }),
      });
      if (handleExpired(res.status)) return;
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);
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
      const res = await fetch(`/api/bookings/${b.id}`, { method: "DELETE" });
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
        body: JSON.stringify({ classEventId: slot.id }),
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
              <img src="/logo_squash.jpeg" alt="" className="logo-mark" />
              Squash de l'Yvette
            </h1>
          </div>
          <div className="actions">
            <ShareButton onCopied={() => toast("ok", "Lien copié ✅")} />
            <ThemeToggle />
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
        {/* Sous-titre sur sa propre ligne pleine largeur → tient sur une seule ligne
            même sur mobile (sinon coincé dans la colonne titre étroite). */}
        <div className="sub">Planning Terrains, Le Complexe, Bures</div>
      </header>

      <p className="hello">Bonjour {me.split(" ")[0]} 👋</p>

      <div className="toolbar">
        <button className="secondary" aria-label="Précédent" onClick={() => setDate(addDays(date, view === "week" ? -7 : -1))}>←</button>
        <button className="secondary" onClick={() => setDate(today)} disabled={date === today}>Aujourd'hui</button>
        <button className="secondary" aria-label="Suivant" onClick={() => setDate(addDays(date, view === "week" ? 7 : 1))}>→</button>
        <span className="date">{view === "week" ? weekLabel(date) : shortPretty(date)}</span>
        <input
          type="date"
          className="datepick"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          // Ouvre le calendrier natif au clic n'importe où dans le champ (zone cliquable élargie)
          onClick={(e) => {
            try {
              e.currentTarget.showPicker?.();
            } catch {
              /* showPicker non supporté / hors geste utilisateur */
            }
          }}
        />
      </div>

      <div className="viewbar">
        <div className="viewtabs" role="group" aria-label="Vue">
          <button className={view === "day" ? "active" : ""} aria-pressed={view === "day"} onClick={() => setView("day")}>Jour</button>
          <button className={view === "week" ? "active" : ""} aria-pressed={view === "week"} onClick={() => setView("week")}>Semaine</button>
        </div>
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

      {view === "day" && (
        <div className="legend">
          <span><i style={{ background: "var(--free)" }} /> Libre</span>
          <span><i style={{ background: "var(--accent)" }} /> Réservé (asso)</span>
          <span><i style={{ background: "var(--booked)" }} /> Réservé (autre)</span>
        </div>
      )}
      {view === "week" && (
        <p className="muted week-hint">
          Chiffre = terrains libres. Touche une case (ou un jour) pour ouvrir la journée et réserver.
        </p>
      )}

      {/* Annonce discrète pour lecteurs d'écran (chargement / erreur). */}
      <p className="sr-only" role="status" aria-live="polite">
        {loading ? "Chargement du planning…" : error ? `Erreur : ${error}` : ""}
      </p>

      {error && <div className="notice error" role="alert">⚠️ {error}</div>}

      {view === "day"
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
                />
              );
            })()
          : loading
            ? <Skeleton />
            : null
        : week.length
          ? <WeekGrid days={week} filter={(iso) => inRange(iso, range)} onPick={pickDay} onBook={onBook} />
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
                    <button className="cancel" onClick={() => onCancel(b)}>
                      Annuler
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <Toasts items={toasts} />
      <ConfirmDialog state={confirmState} onResolve={resolveConfirm} />
    </main>
  );
}

function LoginScreen({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
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

  return (
    <main className="login">
      <h1 className="sr-only">Squash de l'Yvette</h1>
      <img
        src="/logo_squash.jpeg"
        alt="Squash de l'Yvette"
        className="logo-hero"
      />
      <p className="muted">
        Connecte-toi avec ton compte ResaMania (Le Complexe Bures).
      </p>
      <form onSubmit={submit}>
        <input
          type="text"
          placeholder="Identifiant (email)"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
        />
        <input
          type="password"
          placeholder="Mot de passe"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        <button type="submit" disabled={busy}>
          {busy ? "Connexion…" : "Se connecter"}
        </button>
      </form>
      {err && <div className="notice error">⚠️ {err}</div>}
      <p className="muted tiny">
        Tes identifiants servent uniquement à te connecter à ResaMania. Le mot de
        passe n'est pas stocké ; seule une session sécurisée est conservée.
      </p>
    </main>
  );
}
