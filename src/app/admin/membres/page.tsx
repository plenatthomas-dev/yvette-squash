"use client";

// Espace admin — gestion des membres (étape 1). Liste tous les comptes et permet : générer un
// lien d'accès (activation / réinitialisation), désactiver / réactiver, supprimer. L'accès est
// verrouillé CÔTÉ SERVEUR par /api/admin/members (allowlist ADMIN_EMAILS).

import { useEffect, useState } from "react";
import { FEATURE_EMAIL_LOGIN } from "@/lib/features";

type Member = {
  id: string;
  displayName: string;
  nickname: string | null;
  email: string | null;
  mode: "resamania" | "email";
  hasPassword: boolean;
  verified: boolean;
  lastLoginAt: string | null;
  disabledAt: string | null;
  createdAt: string;
};

type Action = "link" | "disable" | "enable" | "delete";

function fmtDate(iso: string | null): string {
  if (!iso) return "jamais";
  return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
}

export default function MembersPage() {
  const [state, setState] = useState<"loading" | "forbidden" | "ready" | "error">("loading");
  const [members, setMembers] = useState<Member[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ id: string; text: string } | null>(null);

  const load = async () => {
    try {
      const res = await fetch("/api/admin/members");
      if (res.status === 403) return setState("forbidden");
      if (!res.ok) return setState("error");
      const data = (await res.json()) as { members: Member[] };
      setMembers(data.members);
      setState("ready");
    } catch {
      setState("error");
    }
  };

  useEffect(() => {
    load();
  }, []);

  const act = async (id: string, action: Action) => {
    if (action === "delete" && !confirm("Supprimer définitivement ce compte ?")) return;
    setBusyId(id);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      const data = (await res.json().catch(() => ({}))) as { link?: string; error?: string };
      if (!res.ok) {
        setMsg({ id, text: data.error ?? "Action impossible." });
        return;
      }
      if (action === "link" && data.link) {
        setLinks((m) => ({ ...m, [id]: data.link! }));
      } else {
        // disable / enable / delete : on recharge la liste pour refléter le nouvel état.
        await load();
      }
    } catch {
      setMsg({ id, text: "Action impossible." });
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
      /* presse-papier indisponible : le lien reste sélectionnable à la main */
    }
  };

  return (
    <main className="login">
      <h1>Membres</h1>
      <p className="muted tiny">
        <a href="/admin">← Retour à l'admin</a>
      </p>

      {state === "loading" && <p className="muted">Chargement…</p>}
      {state === "error" && <div className="notice error">⚠️ Erreur de chargement.</div>}
      {state === "forbidden" && (
        <div className="notice error">⚠️ Accès réservé aux administrateurs.</div>
      )}

      {state === "ready" && (
        <>
          <p className="muted tiny">{members.length} compte{members.length > 1 ? "s" : ""}.</p>
          <ul style={{ listStyle: "none", padding: 0 }}>
            {members.map((m) => (
              <li
                key={m.id}
                style={{
                  border: "1px solid #e5e7eb",
                  borderRadius: 8,
                  padding: "10px 12px",
                  marginBottom: 10,
                  opacity: m.disabledAt ? 0.6 : 1,
                }}
              >
                <div>
                  <strong>{m.displayName}</strong>
                  {m.nickname ? ` (${m.nickname})` : ""}{" "}
                  <span className="muted tiny">{m.mode === "resamania" ? "· ResaMania" : "· Email"}</span>
                </div>
                <div className="muted tiny">{m.email ?? "sans e-mail"}</div>
                <div className="muted tiny">
                  Inscrit le {fmtDate(m.createdAt)} · Dernière connexion : {fmtDate(m.lastLoginAt)}
                </div>
                <div className="tiny" style={{ marginTop: 2 }}>
                  {m.disabledAt && <span style={{ color: "#b91c1c" }}>désactivé</span>}
                  {!m.verified && (
                    <span style={{ color: "#b45309", marginLeft: m.disabledAt ? 8 : 0 }}>
                      non vérifié
                    </span>
                  )}
                </div>

                {links[m.id] && (
                  <div className="notice info" style={{ wordBreak: "break-all", marginTop: 8 }}>
                    <strong>Lien à transmettre :</strong>
                    <br />
                    {links[m.id]}
                    <br />
                    <button type="button" onClick={() => copy(m.id, links[m.id])}>
                      {copied === m.id ? "Copié ✓" : "Copier le lien"}
                    </button>
                  </div>
                )}
                {msg?.id === m.id && (
                  <div className="notice error" style={{ marginTop: 8 }}>
                    ⚠️ {msg.text}
                  </div>
                )}

                <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {FEATURE_EMAIL_LOGIN && m.email && (
                    <button type="button" disabled={busyId === m.id} onClick={() => act(m.id, "link")}>
                      {m.hasPassword ? "Lien de réinitialisation" : "Lien d'activation"}
                    </button>
                  )}
                  {m.disabledAt ? (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busyId === m.id}
                      onClick={() => act(m.id, "enable")}
                    >
                      Réactiver
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busyId === m.id}
                      onClick={() => act(m.id, "disable")}
                    >
                      Désactiver
                    </button>
                  )}
                  <button
                    type="button"
                    className="secondary"
                    disabled={busyId === m.id}
                    onClick={() => act(m.id, "delete")}
                    style={{ color: "#b91c1c" }}
                  >
                    Supprimer
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
