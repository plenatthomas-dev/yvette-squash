"use client";

// Espace admin (inscription sur invitation) : file d'attente des demandes de compte et de
// réinitialisation. L'accès est verrouillé CÔTÉ SERVEUR par /api/admin/requests (allowlist
// ADMIN_EMAILS) — cette page ne fait qu'afficher ce que l'API veut bien lui rendre.

import { useEffect, useState } from "react";
import { FEATURE_EMAIL_LOGIN } from "@/lib/features";

type PendingRequest = {
  id: string;
  email: string;
  purpose: "signup" | "reset";
  displayName: string | null;
  createdAt: string;
};

function purposeLabel(p: PendingRequest["purpose"]): string {
  return p === "signup" ? "Nouveau compte" : "Mot de passe oublié";
}

export default function AdminPage() {
  const [state, setState] = useState<"loading" | "forbidden" | "ready" | "error">("loading");
  const [requests, setRequests] = useState<PendingRequest[]>([]);
  // Lien généré à l'approbation, à transmettre à la personne (par id de demande).
  const [links, setLinks] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!FEATURE_EMAIL_LOGIN) return;
    (async () => {
      try {
        const res = await fetch("/api/admin/requests");
        if (res.status === 403) return setState("forbidden");
        if (!res.ok) return setState("error");
        const data = (await res.json()) as { requests: PendingRequest[] };
        setRequests(data.requests);
        setState("ready");
      } catch {
        setState("error");
      }
    })();
  }, []);

  const act = async (id: string, action: "approve" | "reject") => {
    setBusyId(id);
    try {
      const res = await fetch("/api/admin/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      const data = (await res.json()) as { link?: string };
      if (!res.ok) return;
      if (action === "approve" && data.link) {
        setLinks((m) => ({ ...m, [id]: data.link! }));
      }
      // Dans les deux cas la demande quitte la file (approuvée → lien affiché ; rejetée → retirée).
      setRequests((rs) => rs.filter((r) => r.id !== id));
    } finally {
      setBusyId(null);
    }
  };

  const copy = async (id: string, link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 2000);
    } catch {
      /* clipboard indisponible : le lien reste sélectionnable à la main */
    }
  };

  if (!FEATURE_EMAIL_LOGIN) {
    return (
      <main className="login">
        <h1>Admin</h1>
        <div className="notice error">⚠️ Fonction indisponible.</div>
      </main>
    );
  }

  return (
    <main className="login">
      <h1>Demandes en attente</h1>

      {state === "loading" && <p className="muted">Chargement…</p>}
      {state === "error" && <div className="notice error">⚠️ Erreur de chargement.</div>}
      {state === "forbidden" && (
        <div className="notice error">⚠️ Accès réservé aux administrateurs.</div>
      )}

      {state === "ready" && (
        <>
          <p className="muted tiny">
            Approuve une demande pour générer son lien, puis transmets-le à la personne
            (WhatsApp, SMS…). Le lien ne s'affiche qu'une seule fois.
          </p>

          {/* Liens générés (demandes tout juste approuvées) */}
          {Object.entries(links).map(([id, link]) => (
            <div key={id} className="notice info" style={{ wordBreak: "break-all" }}>
              <strong>Lien à transmettre :</strong>
              <br />
              {link}
              <br />
              <button type="button" onClick={() => copy(id, link)}>
                {copied === id ? "Copié ✓" : "Copier le lien"}
              </button>
            </div>
          ))}

          {requests.length === 0 && Object.keys(links).length === 0 && (
            <p className="muted">Aucune demande en attente.</p>
          )}

          <ul className="admin-requests" style={{ listStyle: "none", padding: 0 }}>
            {requests.map((r) => (
              <li
                key={r.id}
                style={{
                  border: "1px solid #e5e7eb",
                  borderRadius: 8,
                  padding: "10px 12px",
                  marginBottom: 10,
                }}
              >
                <div>
                  <strong>{r.email}</strong>
                  {r.displayName ? ` — ${r.displayName}` : ""}
                </div>
                <div className="muted tiny">
                  {purposeLabel(r.purpose)} · {new Date(r.createdAt).toLocaleString("fr-FR")}
                </div>
                <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    disabled={busyId === r.id}
                    onClick={() => act(r.id, "approve")}
                  >
                    Approuver
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busyId === r.id}
                    onClick={() => act(r.id, "reject")}
                  >
                    Rejeter
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
