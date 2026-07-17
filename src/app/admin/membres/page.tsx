"use client";

// Espace admin — gestion des membres (étape 1). Liste tous les comptes et permet : générer un
// lien d'accès (activation / réinitialisation), désactiver / réactiver, supprimer. L'accès est
// verrouillé CÔTÉ SERVEUR par /api/admin/members (allowlist ADMIN_EMAILS).

import { useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useFeatures } from "@/components/FeatureProvider";

type Member = {
  id: string;
  displayName: string;
  nickname: string | null;
  email: string | null;
  mode: "resamania" | "email";
  hasPassword: boolean;
  verified: boolean;
  passkeyCount: number;
  lastLoginAt: string | null;
  disabledAt: string | null;
  createdAt: string;
};

type Action = "link" | "disable" | "enable" | "revoke_passkeys" | "delete";

// Petite pastille de statut (pas de classe .badge globale : elle n'existe qu'en scopé).
const badge: CSSProperties = {
  fontSize: "0.7rem",
  padding: "1px 7px",
  borderRadius: 999,
  border: "1px solid currentColor",
  whiteSpace: "nowrap",
  lineHeight: 1.6,
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
}

// Dernière connexion : jour + heure (repère plus finement l'activité récente).
function fmtDateTime(iso: string | null): string {
  if (!iso) return "jamais";
  return new Date(iso).toLocaleString("fr-FR", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function MembersPage() {
  const { emailLogin } = useFeatures();
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
    if (
      action === "revoke_passkeys" &&
      !confirm("Retirer tous les passkeys (connexion biométrique) de ce membre ?")
    )
      return;
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
        <Link href="/admin">← Retour à l'admin</Link>
      </p>

      {state === "loading" && <p className="muted">Chargement…</p>}
      {state === "error" && <div className="notice error">⚠️ Erreur de chargement.</div>}
      {state === "forbidden" && (
        <div className="notice error">⚠️ Accès réservé aux administrateurs.</div>
      )}

      {state === "ready" && (
        <>
          <p className="muted tiny">{members.length} compte{members.length > 1 ? "s" : ""}.</p>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Membre</th>
                  <th>Dates</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id} style={{ opacity: m.disabledAt ? 0.55 : 1 }}>
                    {/* Identité + statut */}
                    <td>
                      <div>
                        <strong>{m.displayName}</strong>
                        {m.nickname ? ` (${m.nickname})` : ""}
                      </div>
                      <div className="muted tiny">{m.email ?? "sans e-mail"}</div>
                      <div className="tiny" style={{ marginTop: 2, display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <span style={badge}>{m.mode === "resamania" ? "ResaMania" : "Email"}</span>
                        {m.disabledAt && (
                          <span style={{ ...badge, color: "#b91c1c" }}>désactivé</span>
                        )}
                        {!m.verified && (
                          <span style={{ ...badge, color: "#b45309" }}>non vérifié</span>
                        )}
                        {m.passkeyCount > 0 && (
                          <span style={badge} title="Passkeys enrôlés (connexion biométrique)">
                            🔐 {m.passkeyCount}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Inscription + dernière connexion, sur deux lignes */}
                    <td className="tiny" style={{ whiteSpace: "nowrap" }}>
                      <div>
                        <span className="muted">Inscrit&nbsp;:</span> {fmtDate(m.createdAt)}
                      </div>
                      <div>
                        <span className="muted">Dernière connexion&nbsp;:</span>
                        <br />
                        {fmtDateTime(m.lastLoginAt)}
                      </div>
                    </td>

                    {/* Actions */}
                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {emailLogin && m.email && (
                          <button
                            type="button"
                            className="tiny"
                            disabled={busyId === m.id}
                            onClick={() => act(m.id, "link")}
                          >
                            {m.hasPassword ? "Lien de réinit." : "Lien d'activation"}
                          </button>
                        )}
                        {m.disabledAt ? (
                          <button
                            type="button"
                            className="secondary tiny"
                            disabled={busyId === m.id}
                            onClick={() => act(m.id, "enable")}
                          >
                            Réactiver
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="secondary tiny"
                            disabled={busyId === m.id}
                            onClick={() => act(m.id, "disable")}
                          >
                            Désactiver
                          </button>
                        )}
                        {m.passkeyCount > 0 && (
                          <button
                            type="button"
                            className="secondary tiny"
                            disabled={busyId === m.id}
                            onClick={() => act(m.id, "revoke_passkeys")}
                            title="Retire tous les passkeys du membre (appareil perdu)"
                          >
                            Révoquer biométrie
                          </button>
                        )}
                        <button
                          type="button"
                          className="secondary tiny"
                          disabled={busyId === m.id}
                          onClick={() => act(m.id, "delete")}
                          style={{ color: "#b91c1c" }}
                        >
                          Supprimer
                        </button>
                      </div>

                      {links[m.id] && (
                        <div className="notice info" style={{ wordBreak: "break-all", marginTop: 8 }}>
                          <strong>Lien à transmettre :</strong>
                          <br />
                          {links[m.id]}
                          <br />
                          <button type="button" className="tiny" onClick={() => copy(m.id, links[m.id])}>
                            {copied === m.id ? "Copié ✓" : "Copier le lien"}
                          </button>
                        </div>
                      )}
                      {msg?.id === m.id && (
                        <div className="notice error" style={{ marginTop: 8 }}>
                          ⚠️ {msg.text}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
