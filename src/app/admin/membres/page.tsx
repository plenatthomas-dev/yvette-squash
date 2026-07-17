"use client";

// Espace admin — gestion des membres. Chaque compte est une CARTE (fini le tableau à faire
// défiler horizontalement, sur PC comme sur mobile). Permet : générer un lien d'accès
// (activation / réinitialisation), désactiver / réactiver, révoquer la biométrie (un appareil
// précis ou tous les passkeys), supprimer. L'accès est verrouillé CÔTÉ SERVEUR par
// /api/admin/members (allowlist ADMIN_EMAILS).

import { useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useFeatures } from "@/components/FeatureProvider";

type MemberPasskey = {
  id: string;
  deviceLabel: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

type Member = {
  id: string;
  displayName: string;
  nickname: string | null;
  email: string | null;
  mode: "resamania" | "email";
  hasPassword: boolean;
  verified: boolean;
  passkeys: MemberPasskey[];
  lastLoginAt: string | null;
  disabledAt: string | null;
  createdAt: string;
};

type Action = "link" | "disable" | "enable" | "revoke_passkey" | "revoke_passkeys" | "delete";

// Petite pastille de statut (pas de classe .badge globale : elle n'existe qu'en scopé).
const badge: CSSProperties = {
  fontSize: "0.7rem",
  padding: "1px 7px",
  borderRadius: 999,
  border: "1px solid currentColor",
  whiteSpace: "nowrap",
  lineHeight: 1.6,
};

// Carte membre : remplace une ligne de tableau. S'appuie sur les variables de carte de Pico
// pour suivre automatiquement les thèmes (clair / sombre / rose).
const card: CSSProperties = {
  border: "1px solid var(--pico-card-border-color)",
  background: "var(--pico-card-background-color)",
  borderRadius: 12,
  padding: "12px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
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

  // Cœur d'une action serveur { id, action, … } : gère le « busy », les erreurs et le
  // rechargement. `extra` porte le passkeyId pour la révocation d'un appareil précis.
  const postAction = async (id: string, action: Action, extra?: { passkeyId?: string }) => {
    setBusyId(id);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action, ...extra }),
      });
      const data = (await res.json().catch(() => ({}))) as { link?: string; error?: string };
      if (!res.ok) {
        setMsg({ id, text: data.error ?? "Action impossible." });
        return;
      }
      if (action === "link" && data.link) {
        setLinks((m) => ({ ...m, [id]: data.link! }));
      } else {
        // disable / enable / delete / révocations : on recharge pour refléter le nouvel état.
        await load();
      }
    } catch {
      setMsg({ id, text: "Action impossible." });
    } finally {
      setBusyId(null);
    }
  };

  const act = (id: string, action: Action) => {
    if (action === "delete" && !confirm("Supprimer définitivement ce compte ?")) return;
    if (
      action === "revoke_passkeys" &&
      !confirm("Retirer TOUS les passkeys (connexion biométrique) de ce membre ?")
    )
      return;
    void postAction(id, action);
  };

  const revokePasskey = (id: string, pk: MemberPasskey) => {
    const label = pk.deviceLabel?.trim() || "cet appareil";
    if (!confirm(`Retirer le passkey « ${label} » de ce membre ?`)) return;
    void postAction(id, "revoke_passkey", { passkeyId: pk.id });
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

  // Pas de className="login" ici : cette page a besoin de toute la largeur (jusqu'à 900px, cf.
  // la règle `main`) pour étaler la grille de cartes — la contrainte 400px de `.login` est
  // justement ce qui rendait le tableau illisible sur PC.
  return (
    <main>
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
          <p className="muted tiny">
            {members.length} compte{members.length > 1 ? "s" : ""}.
          </p>
          {/* Grille responsive : plusieurs cartes de front sur PC, une seule sur mobile, sans
              jamais de défilement horizontal (min(280px,100%) empêche tout débordement). */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(min(280px, 100%), 1fr))",
              gap: 12,
              alignItems: "start",
            }}
          >
            {members.map((m) => (
              <section key={m.id} style={{ ...card, opacity: m.disabledAt ? 0.6 : 1 }}>
                {/* Identité */}
                <div>
                  <div>
                    <strong>{m.displayName}</strong>
                    {m.nickname ? ` (${m.nickname})` : ""}
                  </div>
                  <div className="muted tiny">{m.email ?? "sans e-mail"}</div>
                </div>

                {/* Statut */}
                <div className="tiny" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <span style={badge}>{m.mode === "resamania" ? "ResaMania" : "Email"}</span>
                  {m.disabledAt && <span style={{ ...badge, color: "var(--danger-fg)" }}>désactivé</span>}
                  {!m.verified && <span style={{ ...badge, color: "#b45309" }}>non vérifié</span>}
                  {m.passkeys.length > 0 && (
                    <span style={badge} title="Passkeys enrôlés (connexion biométrique)">
                      🔐 {m.passkeys.length}
                    </span>
                  )}
                </div>

                {/* Dates */}
                <div className="tiny muted">
                  <div>Inscrit&nbsp;: {fmtDate(m.createdAt)}</div>
                  <div>Dernière connexion&nbsp;: {fmtDateTime(m.lastLoginAt)}</div>
                </div>

                {/* Appareils biométriques : un « Retirer » par appareil (téléphone perdu, etc.). */}
                {m.passkeys.length > 0 && (
                  <div
                    className="tiny"
                    style={{
                      border: "1px solid var(--pico-card-border-color)",
                      borderRadius: 8,
                      padding: "6px 8px",
                      display: "flex",
                      flexDirection: "column",
                      gap: 5,
                    }}
                  >
                    <div className="muted">Appareils biométriques&nbsp;:</div>
                    {m.passkeys.map((pk) => (
                      <div
                        key={pk.id}
                        style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}
                      >
                        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                          🔐 {pk.deviceLabel?.trim() || "Appareil"}{" "}
                          <span className="muted">
                            · {pk.lastUsedAt ? `vu ${fmtDate(pk.lastUsedAt)}` : "jamais utilisé"}
                          </span>
                        </span>
                        <button
                          type="button"
                          className="secondary tiny"
                          disabled={busyId === m.id}
                          onClick={() => revokePasskey(m.id, pk)}
                          style={{ flex: "0 0 auto" }}
                        >
                          Retirer
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Actions du compte (retour à la ligne libre : jamais de scroll horizontal). */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
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
                  {m.passkeys.length > 1 && (
                    <button
                      type="button"
                      className="secondary tiny"
                      disabled={busyId === m.id}
                      onClick={() => act(m.id, "revoke_passkeys")}
                      title="Retire tous les passkeys du membre d'un coup"
                    >
                      Tout révoquer 🔐
                    </button>
                  )}
                  <button
                    type="button"
                    className="secondary tiny"
                    disabled={busyId === m.id}
                    onClick={() => act(m.id, "delete")}
                    style={{ color: "var(--danger-fg)" }}
                  >
                    Supprimer
                  </button>
                </div>

                {links[m.id] && (
                  <div className="notice info" style={{ wordBreak: "break-all" }}>
                    <strong>Lien à transmettre :</strong>
                    <br />
                    {links[m.id]}
                    <br />
                    <button type="button" className="tiny" onClick={() => copy(m.id, links[m.id])}>
                      {copied === m.id ? "Copié ✓" : "Copier le lien"}
                    </button>
                  </div>
                )}
                {msg?.id === m.id && <div className="notice error">⚠️ {msg.text}</div>}
              </section>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
