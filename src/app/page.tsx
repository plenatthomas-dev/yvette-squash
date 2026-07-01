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
    const when = `${fmtTime(slot.startsAt)} le ${prettyDate(date)}`;
    if (!confirm(`Réserver ${slot.courtName} à ${when} ?`)) return;
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
      alert("Réservation confirmée ✅");
      load(date);
    } catch (e) {
      alert("Réservation impossible : " + (e as Error).message);
    }
  };

  const onCancel = async (b: JournalEntry) => {
    if (!confirm(`Annuler ta réservation de ${b.courtName} à ${fmtTime(b.startsAt)} ?`))
      return;
    try {
      const res = await fetch(`/api/bookings/${b.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);
      alert("Réservation annulée ✅");
      load(date);
    } catch (e) {
      alert("Annulation impossible : " + (e as Error).message);
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
        <div>
          <h1>🎾 Yvette Squash</h1>
          <div className="sub">Le Complexe Bures — planning des terrains</div>
        </div>
        <div className="userbar">
          <span>Bonjour {me}</span>
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

      <div className="toolbar">
        <button className="secondary" onClick={() => setDate(addDays(date, -1))}>←</button>
        <button className="secondary" onClick={() => setDate(toISODate(new Date()))}>Aujourd'hui</button>
        <button className="secondary" onClick={() => setDate(addDays(date, 1))}>→</button>
        <span className="date">{prettyDate(date)}</span>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
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
        <span><i style={{ background: "var(--accent)" }} /> Réservé par le groupe</span>
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
      <h1>🎾 Yvette Squash</h1>
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
