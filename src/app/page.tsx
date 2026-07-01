"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { PlanningDay, Slot } from "@/lib/resamania/types";
import { PlanningGrid } from "@/components/PlanningGrid";

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
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

// --- Filtre de plage horaire -------------------------------------------------
type Range = "all" | "morning" | "afternoon" | "evening";
const RANGES: { key: Range; label: string }[] = [
  { key: "all", label: "Journée" },
  { key: "morning", label: "Matin" },
  { key: "afternoon", label: "Après-midi" },
  { key: "evening", label: "Soir" },
];
// Minutes depuis minuit lues directement dans l'ISO (évite tout décalage de fuseau).
function slotMinutes(iso: string): number {
  const m = iso.match(/T(\d{2}):(\d{2})/);
  return m ? +m[1] * 60 + +m[2] : 0;
}
function inRange(iso: string, r: Range): boolean {
  const t = slotMinutes(iso);
  switch (r) {
    case "morning": // 9h00 → 12h00 inclus
      return t >= 9 * 60 && t <= 12 * 60;
    case "afternoon": // 12h30 → 17h30 inclus
      return t >= 12 * 60 + 30 && t <= 17 * 60 + 30;
    case "evening": // à partir de 18h00
      return t >= 18 * 60;
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

  useEffect(() => {
    if (me) load(date);
  }, [me, date, load]);

  const onBook = async (slot: Slot) => {
    const ok = await askConfirm({
      title: "Réserver ce créneau ?",
      body: `${slot.courtName} — ${fmtTime(slot.startsAt)} le ${prettyDate(date)}`,
      confirmLabel: "Réserver",
    });
    if (!ok) return;
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
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);
      toast("ok", "Réservation confirmée");
      load(date);
    } catch (e) {
      toast("err", "Réservation impossible : " + (e as Error).message);
    }
  };

  const onCancel = async (b: JournalEntry) => {
    const ok = await askConfirm({
      title: "Annuler la réservation ?",
      body: `${b.courtName} — ${fmtTime(b.startsAt)} le ${prettyDate(date)}`,
      confirmLabel: "Annuler la résa",
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/bookings/${b.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);
      toast("ok", "Réservation annulée");
      load(date);
    } catch (e) {
      toast("err", "Annulation impossible : " + (e as Error).message);
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
        <div className="brand">
          <h1>
            <img src="/logo_squash.jpeg" alt="" className="logo-mark" />
            Squash de l'Yvette
          </h1>
          <div className="sub">Planning Terrains, Le Complexe, Bures</div>
        </div>
        <div className="actions">
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
      </header>

      <p className="hello">Bonjour {me.split(" ")[0]} 👋</p>

      <div className="toolbar">
        <button className="secondary" onClick={() => setDate(addDays(date, -1))}>←</button>
        <button className="secondary" onClick={() => setDate(toISODate(new Date()))}>Aujourd'hui</button>
        <button className="secondary" onClick={() => setDate(addDays(date, 1))}>→</button>
        <span className="date">{prettyDate(date)}</span>
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

      <div className="legend">
        <span><i style={{ background: "var(--free)" }} /> Libre</span>
        <span><i style={{ background: "var(--accent)" }} /> Réservé (asso)</span>
        <span><i style={{ background: "var(--booked)" }} /> Réservé (autre)</span>
      </div>

      {error && <div className="notice error">⚠️ {error}</div>}
      {loading && <p className="muted">Chargement du planning…</p>}
      {planning &&
        (() => {
          const slots = planning.slots.filter((s) => inRange(s.startsAt, range));
          if (slots.length === 0) {
            return <p className="muted">Aucun créneau sur cette plage horaire.</p>;
          }
          return <PlanningGrid planning={{ ...planning, slots }} onBook={onBook} />;
        })()}

      <section className="journal">
        <h2>👥 Réservations du groupe — {prettyDate(date)}</h2>
        {journal.length === 0 ? (
          <p className="muted">Personne du groupe n'a (encore) réservé ce jour-là.</p>
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
