"use client";

// Espace admin — gestion des membres. Chaque compte est une CARTE (fini le tableau à faire
// défiler horizontalement, sur PC comme sur mobile). Permet : générer un lien d'accès
// (activation / réinitialisation), désactiver / réactiver, révoquer la biométrie (un appareil
// précis ou tous les passkeys), supprimer. L'accès est verrouillé CÔTÉ SERVEUR par
// /api/admin/members (allowlist ADMIN_EMAILS).

import { useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useFeatures } from "@/components/FeatureProvider";
import { memberOriginLabel } from "@/lib/booking-origin";

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
  lastSeenAt: string | null;
  disabledAt: string | null;
  createdAt: string;
  // Équipe interclub (null = aucune). Décidée ICI et nulle part ailleurs : elle commande qui
  // peut être aligné dans une rencontre, ce n'est donc pas un réglage que le membre se donne.
  teamId: string | null;
  // Résas du membre sur 30 j, par origine. Mises en mots par memberOriginLabel, qui tient
  // compte de `mode` : un compte « email seul » n'est pas mesurable côté ResaMania.
  bookingsApp: number;
  bookingsResa: number;
};

type Team = { id: string; name: string };

type Action =
  | "link"
  | "disable"
  | "enable"
  | "revoke_passkey"
  | "revoke_passkeys"
  | "delete"
  | "set_team";

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

// Le switch d'équipe est étroit : « Équipe 1 » y tiendrait mal à côté de « Aucune ». On
// n'affiche que ce qui suit « Équipe » quand le nom suit la convention, le nom entier sinon.
// Le nom complet reste porté par le `title` et par le libellé lecteur d'écran du bouton.
function shortTeamName(name: string): string {
  const m = /^équipe\s+(\S.*)$/i.exec(name.trim());
  return m ? m[1] : name;
}

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
  const { emailLogin, interclub } = useFeatures();
  const [state, setState] = useState<"loading" | "forbidden" | "ready" | "error">("loading");
  const [members, setMembers] = useState<Member[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  // Flag `externalBookings` côté serveur : pilote la mise en mots des compteurs d'origine.
  const [externalDetection, setExternalDetection] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ id: string; text: string } | null>(null);

  const load = async () => {
    try {
      const res = await fetch("/api/admin/members");
      if (res.status === 403) return setState("forbidden");
      if (!res.ok) return setState("error");
      const data = (await res.json()) as {
        members: Member[];
        teams?: Team[];
        externalDetection?: boolean;
      };
      setMembers(data.members);
      setTeams(data.teams ?? []);
      setExternalDetection(!!data.externalDetection);
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
  const postAction = async (
    id: string,
    action: Action,
    extra?: { passkeyId?: string; teamId?: string | null },
  ) => {
    setBusyId(id);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action, ...extra }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        link?: string;
        error?: string;
        teamId?: string | null;
      };
      if (!res.ok) {
        setMsg({ id, text: data.error ?? "Action impossible." });
        return;
      }
      if (action === "link" && data.link) {
        setLinks((m) => ({ ...m, [id]: data.link! }));
      } else if (action === "set_team") {
        // Pas de rechargement ici, à la différence des autres actions : composer les équipes,
        // c'est enchaîner vingt sélecteurs d'affilée, et `listMembers` agrège au passage les
        // réservations de TOUS les membres sur 30 jours. Vingt allers-retours de cette taille
        // pour changer vingt listes déroulantes réveillerait Neon pour rien. La réponse du
        // serveur fait foi (`data.teamId`), on recale simplement la ligne concernée.
        setMembers((prev) =>
          prev.map((m) => (m.id === id ? { ...m, teamId: data.teamId ?? null } : m)),
        );
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

  // Retaper la position DÉJÀ active n'écrit rien : sur un switch, viser le choix courant est
  // un geste ordinaire (on vérifie, on hésite), et le menu déroulant qu'il remplace ne
  // déclenchait pas non plus de `change` dans ce cas.
  const setTeam = (id: string, teamId: string | null) => {
    const current = members.find((m) => m.id === id)?.teamId ?? null;
    if (current === teamId) return;
    void postAction(id, "set_team", { teamId });
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

  // Pas de className="login" ici : cette page a besoin de toute la largeur pour étaler la grille
  // de cartes — la contrainte 400px de `.login` est justement ce qui rendait le tableau illisible
  // sur PC. On élargit même AU-DELÀ des 900px de la règle globale `main` (override inline, propre
  // à cette page) : sur grand écran, 900px ne tenait que 2 cartes en laissant de larges marges
  // vides. `margin-inline:auto` et le `padding` de la règle `main` restent hérités.
  return (
    <main style={{ maxWidth: 1200 }}>
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
            {members.length} compte{members.length > 1 ? "s" : ""}
            {members.length > 0 && (
              <>
                {" · "}🔐 {members.filter((m) => m.passkeys.length > 0).length}/{members.length} ont
                activé la biométrie
              </>
            )}
            .
          </p>
          {/* Grille responsive : plusieurs cartes de front sur PC (≈3 colonnes dans les 1200px),
              une seule sur mobile, sans jamais de défilement horizontal (min(320px,100%) empêche
              tout débordement). Largeur mini montée à 320px pour des cartes confortables plutôt
              que des colonnes trop étroites. */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(min(320px, 100%), 1fr))",
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
                  {!m.verified && <span style={{ ...badge, color: "var(--warn-fg)" }}>non vérifié</span>}
                  {m.passkeys.length > 0 && (
                    <span style={badge} title="Passkeys enrôlés (connexion biométrique)">
                      🔐 {m.passkeys.length}
                    </span>
                  )}
                </div>

                {/* Dates */}
                <div className="tiny muted">
                  <div>Inscrit&nbsp;: {fmtDate(m.createdAt)}</div>
                  <div>Dernière authentification&nbsp;: {fmtDateTime(m.lastLoginAt)}</div>
                  <div>Dernière connexion&nbsp;: {fmtDateTime(m.lastSeenAt)}</div>
                  {/* Origine des résas (30 j). Le libellé dit explicitement quand on ne PEUT
                      pas savoir (détection coupée, ou compte non lié à ResaMania) plutôt que
                      d'afficher un « 0 » qui se lirait comme une mesure. */}
                  <div title="Réservations des 30 derniers jours, par origine. Le compte « sur ResaMania » ne couvre que les jours consultés dans l'appli : c'est un minimum.">
                    Résas (30 j)&nbsp;:{" "}
                    {memberOriginLabel(
                      {
                        linked: m.mode === "resamania",
                        bookingsApp: m.bookingsApp,
                        bookingsResa: m.bookingsResa,
                      },
                      externalDetection,
                    )}
                  </div>
                </div>

                {/* Équipe interclub. Switch à positions, pas un menu déroulant : le choix est
                    court et fermé (Aucune / Équipe 1 / Équipe 2), et l'état de CHAQUE membre se
                    lit sans rien ouvrir — sur une liste de vingt cartes, un menu à déplier puis
                    replier à chaque ligne était le vrai coût. Même gabarit que le switch des
                    fonctions de l'appli. Enregistré au tap, sans bouton « valider ». */}
                {interclub && teams.length > 0 && (
                  <div
                    className="tiny"
                    style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
                  >
                    <span className="muted" style={{ flex: "0 0 auto" }}>
                      Équipe interclub&nbsp;:
                    </span>
                    <div
                      className="team-switch"
                      role="group"
                      aria-label={`Équipe interclub de ${m.displayName}`}
                    >
                      <button
                        type="button"
                        aria-pressed={m.teamId === null}
                        disabled={busyId === m.id}
                        onClick={() => setTeam(m.id, null)}
                        title="Ne joue pas le championnat"
                      >
                        Aucune
                      </button>
                      {teams.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          aria-pressed={m.teamId === t.id}
                          disabled={busyId === m.id}
                          onClick={() => setTeam(m.id, t.id)}
                          title={t.name}
                        >
                          {shortTeamName(t.name)}
                          <span className="sr-only"> ({t.name})</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

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
