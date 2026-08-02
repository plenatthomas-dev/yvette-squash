"use client";

// Espace admin — modération des tricounts (étape 5). Liste et suppression d'un groupe de
// partage de frais. Accès verrouillé CÔTÉ SERVEUR par /api/admin/tricounts (allowlist).

import { useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";

type Tricount = {
  id: string;
  date: string;
  title: string | null;
  expenseCount: number;
  totalCents: number;
  participantCount: number;
  createdAt: string;
};

// Carte encadrée, cohérente avec les autres pages /admin (bordure/fond thémés).
const card: CSSProperties = {
  border: "1px solid var(--pico-card-border-color, #e5e7eb)",
  borderRadius: 10,
  padding: "14px 16px",
  background: "var(--pico-card-background-color, transparent)",
};

function euros(cents: number): string {
  return (cents / 100).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
}

function fmtDay(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("fr-FR", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function TricountsAdminPage() {
  const [state, setState] = useState<"loading" | "forbidden" | "ready" | "error">("loading");
  const [tricounts, setTricounts] = useState<Tricount[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch("/api/admin/tricounts");
      if (res.status === 403) return setState("forbidden");
      if (!res.ok) return setState("error");
      setTricounts(((await res.json()) as { tricounts: Tricount[] }).tricounts);
      setState("ready");
    } catch {
      setState("error");
    }
  };

  useEffect(() => {
    load();
  }, []);

  const remove = async (t: Tricount) => {
    if (!confirm(`Supprimer le tricount du ${fmtDay(t.date)} et toutes ses dépenses ?`)) return;
    setBusyId(t.id);
    try {
      const res = await fetch("/api/admin/tricounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: t.id, action: "delete" }),
      });
      if (res.ok) await load();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <main style={{ maxWidth: 1000 }}>
      <h1>Tricounts</h1>
      <p className="muted tiny">
        <Link href="/admin">← Retour à l'admin</Link>
      </p>

      {state === "loading" && <p className="muted">Chargement…</p>}
      {state === "error" && <div className="notice error">⚠️ Erreur de chargement.</div>}
      {state === "forbidden" && (
        <div className="notice error">⚠️ Accès réservé aux administrateurs.</div>
      )}

      {state === "ready" && (
        <section style={card}>
          <p className="muted tiny" style={{ marginTop: 0 }}>
            {tricounts.length} tricount{tricounts.length > 1 ? "s" : ""}. La suppression efface
            aussi ses dépenses, parts, approbations et commentaires.
          </p>
          {tricounts.length === 0 ? (
            <p className="muted" style={{ marginBottom: 0 }}>Aucun tricount.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Jour</th>
                    <th>Détail</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {tricounts.map((t) => (
                    <tr key={t.id}>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <strong>{fmtDay(t.date)}</strong>
                        {t.title ? <div className="muted tiny">{t.title}</div> : null}
                      </td>
                      <td className="tiny">
                        {euros(t.totalCents)} · {t.expenseCount} dépense
                        {t.expenseCount > 1 ? "s" : ""} · {t.participantCount} participant
                        {t.participantCount > 1 ? "s" : ""}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="secondary tiny"
                          disabled={busyId === t.id}
                          onClick={() => remove(t)}
                          style={{ color: "var(--error-fg)" }}
                        >
                          Supprimer
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
