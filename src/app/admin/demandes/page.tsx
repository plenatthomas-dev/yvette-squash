"use client";

// Espace admin — historique des demandes traitées + blocklist (étape 3). Accès verrouillé
// CÔTÉ SERVEUR par /api/admin/history et /api/admin/blocklist (allowlist ADMIN_EMAILS).

import { useEffect, useState } from "react";
import Link from "next/link";

type HistoryEntry = {
  id: string;
  email: string;
  purpose: "signup" | "reset";
  displayName: string | null;
  outcome: "approved" | "rejected";
  createdAt: string;
};
type Block = { email: string; reason: string | null; createdAt: string };

function purposeLabel(p: HistoryEntry["purpose"]): string {
  return p === "signup" ? "Nouveau compte" : "Mot de passe oublié";
}

export default function RequestsHistoryPage() {
  const [state, setState] = useState<"loading" | "forbidden" | "ready" | "error">("loading");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [newEmail, setNewEmail] = useState("");
  const [newReason, setNewReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try {
      const [hRes, bRes] = await Promise.all([
        fetch("/api/admin/history"),
        fetch("/api/admin/blocklist"),
      ]);
      if (hRes.status === 403 || bRes.status === 403) return setState("forbidden");
      if (!hRes.ok || !bRes.ok) return setState("error");
      setHistory(((await hRes.json()) as { history: HistoryEntry[] }).history);
      setBlocks(((await bRes.json()) as { blocks: Block[] }).blocks);
      setState("ready");
    } catch {
      setState("error");
    }
  };

  useEffect(() => {
    load();
  }, []);

  const block = async (action: "add" | "remove", email: string, reason?: string) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/blocklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, email, reason }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setErr(data.error ?? "Action impossible.");
        return;
      }
      if (action === "add") {
        setNewEmail("");
        setNewReason("");
      }
      await load();
    } catch {
      setErr("Action impossible.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <h1>Historique &amp; blocklist</h1>
      <p className="muted tiny">
        <Link href="/admin">← Retour à l'admin</Link>
      </p>

      {state === "loading" && <p className="muted">Chargement…</p>}
      {state === "error" && <div className="notice error">⚠️ Erreur de chargement.</div>}
      {state === "forbidden" && (
        <div className="notice error">⚠️ Accès réservé aux administrateurs.</div>
      )}

      {state === "ready" && (
        <>
          {/* Blocklist */}
          <section style={{ marginBottom: 28 }}>
            <h2 style={{ fontSize: "1.1rem" }}>Blocklist</h2>
            <p className="muted tiny">
              Une adresse bloquée ne peut plus déposer de demande d'inscription (silencieusement).
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
              <input
                type="email"
                placeholder="email@exemple.fr"
                value={newEmail}
                disabled={busy}
                onChange={(e) => setNewEmail(e.target.value)}
                style={{ flex: "1 1 180px", marginBottom: 0 }}
              />
              <input
                type="text"
                placeholder="Motif (optionnel)"
                value={newReason}
                disabled={busy}
                onChange={(e) => setNewReason(e.target.value)}
                style={{ flex: "1 1 140px", marginBottom: 0 }}
              />
              <button
                type="button"
                disabled={busy || !newEmail.trim()}
                onClick={() => block("add", newEmail.trim(), newReason.trim() || undefined)}
              >
                Bloquer
              </button>
            </div>
            {err && <div className="notice error">⚠️ {err}</div>}
            {blocks.length === 0 ? (
              <p className="muted tiny">Aucune adresse bloquée.</p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0 }}>
                {blocks.map((b) => (
                  <li
                    key={b.email}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      borderBottom: "1px solid #eee",
                      padding: "6px 0",
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <strong>{b.email}</strong>
                      {b.reason ? <span className="muted tiny"> — {b.reason}</span> : ""}
                    </div>
                    <button
                      type="button"
                      className="secondary tiny"
                      disabled={busy}
                      onClick={() => block("remove", b.email)}
                    >
                      Débloquer
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Historique */}
          <section>
            <h2 style={{ fontSize: "1.1rem" }}>Historique des demandes</h2>
            {history.length === 0 ? (
              <p className="muted tiny">Aucune demande traitée.</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Demande</th>
                      <th>Décision</th>
                      <th>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.id}>
                        <td>
                          <div>
                            <strong>{h.email}</strong>
                            {h.displayName ? ` — ${h.displayName}` : ""}
                          </div>
                          <div className="muted tiny">{purposeLabel(h.purpose)}</div>
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          {h.outcome === "approved" ? (
                            <span style={{ color: "#166534" }}>approuvée</span>
                          ) : (
                            <span style={{ color: "#b91c1c" }}>rejetée</span>
                          )}
                        </td>
                        <td className="tiny" style={{ whiteSpace: "nowrap" }}>
                          {new Date(h.createdAt).toLocaleString("fr-FR", {
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
