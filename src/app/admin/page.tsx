"use client";

// Espace admin (inscription sur invitation) : file d'attente des demandes de compte et de
// réinitialisation. L'accès est verrouillé CÔTÉ SERVEUR par /api/admin/requests (allowlist
// ADMIN_EMAILS) — cette page ne fait qu'afficher ce que l'API veut bien lui rendre.

import { useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useFeatures } from "@/components/FeatureProvider";
import FeatureFlagsPanel from "@/components/FeatureFlagsPanel";
import { recheckBanner } from "@/components/AnnouncementBanner";
import { bookingOriginHint } from "@/lib/booking-origin";

type PendingRequest = {
  id: string;
  email: string;
  purpose: "signup" | "reset";
  displayName: string | null;
  createdAt: string;
};

type CronRun = { name: string; lastRunAt: string; ok: boolean; info: string | null };

/** Équipe interclub et son effectif inscrit sur l'appli (l'affectation se fait page Membres). */
type IcTeam = { id: string; name: string; memberCount: number };
/** Joueur d'une équipe SANS compte : il joue le championnat sans utiliser l'appli. */
type IcGuest = { id: string; teamId: string; name: string };
type Dashboard = {
  members: number;
  disabledMembers: number;
  activeSessions: number;
  resaSessions: number;
  recentLogins: number;
  activeAlerts: number;
  pendingRequests: number;
  blockedEmails: number;
  // Origine des résas actives sur 30 j : via l'appli vs détectées directement sur ResaMania.
  bookingsApp: number;
  bookingsResa: number;
  // false ⇒ la détection « hors appli » est coupée, donc bookingsResa vaut 0 par construction.
  externalDetection: boolean;
  crons: CronRun[];
};

function purposeLabel(p: PendingRequest["purpose"]): string {
  return p === "signup" ? "Nouveau compte" : "Mot de passe oublié";
}

// Carte encadrée : donne une identité visuelle à chaque bloc d'options (plus lisible qu'une
// longue pile de sections sans séparation).
const card: CSSProperties = {
  border: "1px solid var(--pico-card-border-color, #e5e7eb)",
  borderRadius: 10,
  padding: "14px 16px",
  background: "var(--pico-card-background-color, transparent)",
};

// Variante pour les cartes disposées en colonnes (masonry) : `breakInside: avoid` empêche
// qu'une carte soit coupée entre deux colonnes.
const masonryCard: CSSProperties = { ...card, breakInside: "avoid", marginBottom: 16 };

export default function AdminPage() {
  const { emailLogin, ranking, interclub } = useFeatures();
  const [state, setState] = useState<"loading" | "forbidden" | "ready" | "error">("loading");
  const [requests, setRequests] = useState<PendingRequest[]>([]);
  // Lien généré à l'approbation, à transmettre à la personne (par id de demande).
  const [links, setLinks] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Annonce push à tous les membres (étape 0 de l'espace admin).
  const [annTitle, setAnnTitle] = useState("");
  const [annBody, setAnnBody] = useState("");
  const [annBusy, setAnnBusy] = useState(false);
  const [annResult, setAnnResult] = useState<{ ok: boolean; text: string } | null>(null);

  // Bannière d'annonce (étape 2) : message affiché en haut de l'appli pour tous.
  const [bnMessage, setBnMessage] = useState("");
  const [bnLevel, setBnLevel] = useState<"info" | "warn">("info");
  const [bnBusy, setBnBusy] = useState(false);
  const [bnResult, setBnResult] = useState<{ ok: boolean; text: string } | null>(null);
  // Y a-t-il une annonce PUBLIÉE ? À distinguer du champ de saisie : on peut y taper un texte
  // sans l'avoir enregistré. Sans ça, « Retirer » était toujours actif et répondait
  // « Bannière retirée » alors qu'il n'avait rien retiré.
  const [bnPublished, setBnPublished] = useState(false);

  // Blocage de l'appli : ferme l'appli aux membres (connexion + réservation), l'admin garde
  // l'accès complet. `blkLoaded` évite d'afficher un switch « ouvert » avant d'avoir lu l'état
  // réel — sur une appli fermée, ce faux « ouvert » serait trompeur.
  const [blkEnabled, setBlkEnabled] = useState(false);
  const [blkMessage, setBlkMessage] = useState("");
  const [blkLoaded, setBlkLoaded] = useState(false);
  const [blkBusy, setBlkBusy] = useState(false);
  const [blkResult, setBlkResult] = useState<{ ok: boolean; text: string } | null>(null);

  // Mini-tableau de bord (étape 4).
  const [dash, setDash] = useState<Dashboard | null>(null);

  // Rafraîchissement à la demande du classement squashnet (rattrape les nouveaux inscrits).
  const [rkBusy, setRkBusy] = useState(false);
  const [rkResult, setRkResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [icBusy, setIcBusy] = useState(false);
  const [icResult, setIcResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [icTeams, setIcTeams] = useState<IcTeam[]>([]);
  const [icGuests, setIcGuests] = useState<IcGuest[]>([]);
  const [icTeamId, setIcTeamId] = useState("");
  const [icName, setIcName] = useState("");

  useEffect(() => {
    if (!emailLogin) return;
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
  }, [emailLogin]);

  // Pré-remplit le formulaire avec la bannière courante (pour l'éditer / l'effacer).
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/banner");
        if (!res.ok) return;
        const data = (await res.json()) as {
          banner: { message: string; level: "info" | "warn" } | null;
        };
        setBnPublished(data.banner !== null);
        if (data.banner) {
          setBnMessage(data.banner.message);
          setBnLevel(data.banner.level);
        }
      } catch {
        /* pas de bannière à pré-remplir */
      }
    })();
  }, []);

  // État courant du blocage (switch + message déjà saisi).
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/block");
        if (!res.ok) return;
        const data = (await res.json()) as { enabled: boolean; message: string };
        setBlkEnabled(data.enabled);
        setBlkMessage(data.message);
        setBlkLoaded(true);
      } catch {
        /* état indisponible : le panneau reste en lecture « inconnue » */
      }
    })();
  }, []);

  // Indicateurs du tableau de bord.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/dashboard");
        if (res.ok) setDash((await res.json()) as Dashboard);
      } catch {
        /* dashboard indisponible : on n'affiche simplement rien */
      }
    })();
  }, []);

  // Roster interclub. Chargé seulement si la fonction est active : sinon c'est une requête
  // Postgres de plus à chaque ouverture de l'admin, pour une section qui ne s'affiche pas.
  useEffect(() => {
    if (!interclub) return;
    void loadTeams();
    // `loadTeams` est stable pour ce qui nous intéresse (il ne lit que des setters) ; le
    // relister en dépendance rejouerait la requête à chaque rendu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interclub]);

  const act = async (id: string, action: "approve" | "reject" | "reject-block") => {
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
      // Dans tous les cas la demande quitte la file (approuvée → lien affiché ; rejetée → retirée).
      setRequests((rs) => rs.filter((r) => r.id !== id));
    } finally {
      setBusyId(null);
    }
  };

  const sendAnnounce = async () => {
    const title = annTitle.trim();
    const body = annBody.trim();
    if (!title || !body) return;
    setAnnBusy(true);
    setAnnResult(null);
    try {
      const res = await fetch("/api/admin/announce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        recipients?: number;
        sent?: number;
        error?: string;
      };
      if (!res.ok) {
        setAnnResult({ ok: false, text: data.error ?? "Envoi impossible." });
        return;
      }
      const n = data.recipients ?? 0;
      setAnnResult({
        ok: true,
        // On distingue membres et APPAREILS : « 2 membres » ne dit pas si le téléphone visé
        // était du lot, et c'est justement la question qu'on se pose quand rien n'arrive.
        text:
          n === 0
            ? "Aucun membre abonné aux notifications."
            : `Envoyée à ${n} membre${n > 1 ? "s" : ""} (${data.sent ?? n} appareil${(data.sent ?? n) > 1 ? "s" : ""}).`,
      });
      setAnnTitle("");
      setAnnBody("");
    } catch {
      setAnnResult({ ok: false, text: "Envoi impossible." });
    } finally {
      setAnnBusy(false);
    }
  };

  // Pose ou retire la bannière. Un message vide efface la bannière côté serveur.
  const saveBanner = async (clear: boolean) => {
    setBnBusy(true);
    setBnResult(null);
    try {
      const res = await fetch("/api/admin/banner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: clear ? "" : bnMessage.trim(), level: bnLevel }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setBnResult({ ok: false, text: data.error ?? "Enregistrement impossible." });
        return;
      }
      if (clear) setBnMessage("");
      setBnPublished(!clear);
      setBnResult({ ok: true, text: clear ? "Bannière retirée." : "Bannière enregistrée." });
      // La bannière vit dans le layout : sans ce signal, l'admin ne verrait son annonce
      // qu'en rechargeant la page (publier ne provoque ni remontage ni focus).
      recheckBanner();
    } catch {
      setBnResult({ ok: false, text: "Enregistrement impossible." });
    } finally {
      setBnBusy(false);
    }
  };

  // Ferme ou rouvre l'appli. `enabled` est l'état VOULU (le switch est piloté par le serveur :
  // on ne bascule l'affichage qu'après confirmation, pour ne jamais laisser croire que l'appli
  // est fermée si l'enregistrement a échoué).
  const saveBlock = async (enabled: boolean) => {
    setBlkBusy(true);
    setBlkResult(null);
    try {
      const res = await fetch("/api/admin/block", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, message: blkMessage.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        enabled?: boolean;
        message?: string;
      };
      if (!res.ok) {
        setBlkResult({ ok: false, text: data.error ?? "Enregistrement impossible." });
        return;
      }
      setBlkEnabled(data.enabled ?? enabled);
      if (typeof data.message === "string") setBlkMessage(data.message);
      setBlkResult({
        ok: true,
        text: enabled
          ? "Appli fermée aux membres. Toi, tu gardes l'accès complet."
          : "Appli rouverte à tous les membres.",
      });
    } catch {
      setBlkResult({ ok: false, text: "Enregistrement impossible." });
    } finally {
      setBlkBusy(false);
    }
  };

  // Roster des équipes : les joueurs SANS compte sur l'appli. Les membres inscrits, eux, sont
  // rattachés depuis la page « Membres », où la liste des comptes vit déjà — dupliquer cette
  // liste ici aurait fait deux endroits pour la même décision.
  const loadTeams = async () => {
    try {
      const res = await fetch("/api/admin/interclub-teams");
      if (!res.ok) return;
      const data = (await res.json()) as { teams: IcTeam[]; guests: IcGuest[] };
      setIcTeams(data.teams);
      setIcGuests(data.guests);
    } catch {
      /* la section reste vide : le reste de l'admin n'a pas à en souffrir */
    }
  };

  const addGuest = async () => {
    const name = icName.trim();
    if (!name || !icTeamId) return;
    setIcBusy(true);
    setIcResult(null);
    try {
      const res = await fetch("/api/admin/interclub-teams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add_guest", teamId: icTeamId, name }),
      });
      const data = (await res.json().catch(() => ({}))) as { guest?: IcGuest; error?: string };
      if (!res.ok || !data.guest) {
        setIcResult({ ok: false, text: data.error ?? "Ajout impossible." });
        return;
      }
      setIcGuests((prev) => [...prev, data.guest!].sort((a, b) => a.name.localeCompare(b.name, "fr")));
      setIcName("");
      setIcResult({ ok: true, text: `${data.guest.name} ajouté.` });
    } catch {
      setIcResult({ ok: false, text: "Ajout impossible." });
    } finally {
      setIcBusy(false);
    }
  };

  const removeGuest = async (g: IcGuest) => {
    if (!confirm(`Retirer ${g.name} de l'équipe ? Les rencontres déjà jouées gardent son nom.`)) {
      return;
    }
    setIcBusy(true);
    setIcResult(null);
    try {
      const res = await fetch("/api/admin/interclub-teams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove_guest", guestId: g.id }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setIcResult({ ok: false, text: data.error ?? "Retrait impossible." });
        return;
      }
      setIcGuests((prev) => prev.filter((x) => x.id !== g.id));
    } catch {
      setIcResult({ ok: false, text: "Retrait impossible." });
    } finally {
      setIcBusy(false);
    }
  };

  const refreshRankings = async () => {
    setRkBusy(true);
    setRkResult(null);
    try {
      const res = await fetch("/api/admin/refresh-rankings", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        matched?: number;
        members?: number;
        cleared?: number;
        skipped?: number;
        failed?: number;
        bulkMoveBlocked?: boolean;
        error?: string;
      };
      if (!res.ok) {
        setRkResult({ ok: false, text: data.error ?? "Rafraîchissement impossible." });
        return;
      }
      const matched = data.matched ?? 0;
      const cleared = data.cleared ?? 0;
      const skipped = data.skipped ?? 0;
      const failed = data.failed ?? 0;
      const members = data.members ?? 0;
      const text =
        `${matched} classement${matched > 1 ? "s" : ""} à jour` +
        `${cleared ? `, ${cleared} retiré${cleared > 1 ? "s" : ""}` : ""}` +
        `${skipped ? `, ${skipped} ignoré${skipped > 1 ? "s" : ""} (non concluant)` : ""}` +
        `${failed ? `, ${failed} échec${failed > 1 ? "s" : ""} (base)` : ""}` +
        ` sur ${members} membre${members > 1 ? "s" : ""} listé${members > 1 ? "s" : ""}.`;
      // On reprend le `ok` de la route (échec base, blocage anti-effacement, OU squashnet muet
      // = tous ignorés) plutôt que de recomposer le critère ici. Le blocage a un message dédié.
      const succeeded = data.ok ?? true;
      setRkResult({
        ok: succeeded,
        text: data.bulkMoveBlocked
          ? `⚠️ Anomalie : trop de membres « absents » d'un coup — suppressions bloquées (libellé du club changé côté squashnet ?). ${text}`
          : text,
      });
    } catch {
      setRkResult({ ok: false, text: "Rafraîchissement impossible." });
    } finally {
      setRkBusy(false);
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

  // La file d'attente dépend de la connexion « email seul » (inscription sur invitation).
  // Le panneau des fonctions reste affiché : sans lui, couper `emailLogin` verrouillerait
  // l'admin hors du seul écran permettant de le rallumer.
  if (!emailLogin) {
    return (
      <main style={{ maxWidth: 720 }}>
        <h1>Admin</h1>
        <p className="muted tiny">
          <Link href="/">← Retour à mon compte</Link>
        </p>
        <div className="notice error">
          ⚠️ La connexion « email seul » est coupée : la file des demandes est indisponible.
        </div>
        <div style={card}>
          <FeatureFlagsPanel />
        </div>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 1000 }}>
      <h1>Admin</h1>
      <p className="muted tiny">
        <Link href="/">← Retour à mon compte</Link>
      </p>

      {state === "loading" && <p className="muted">Chargement…</p>}
      {state === "error" && <div className="notice error">⚠️ Erreur de chargement.</div>}
      {state === "forbidden" && (
        <div className="notice error">⚠️ Accès réservé aux administrateurs.</div>
      )}

      {state === "ready" && (
        <>
          {/* Mini-tableau de bord (étape 4) : indicateurs d'un coup d'œil. */}
          {dash && (
            <section style={{ ...card, marginBottom: 20 }}>
              <h2 style={{ fontSize: "1.1rem", marginTop: 0 }}>Tableau de bord</h2>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
                  gap: 8,
                }}
              >
                <Stat label="Membres" value={dash.members} hint={dash.disabledMembers ? `${dash.disabledMembers} désactivé(s)` : undefined} />
                <Stat label="Actifs (30 j)" value={dash.recentLogins} />
                <Stat label="Sessions" value={dash.activeSessions} hint={`${dash.resaSessions} ResaMania`} />
                <Stat label="Alertes terrain" value={dash.activeAlerts} />
                <Stat label="En attente" value={dash.pendingRequests} />
                <Stat label="Bloqués" value={dash.blockedEmails} />
                <Stat
                  label="Résas (30 j)"
                  value={dash.bookingsApp + dash.bookingsResa}
                  hint={bookingOriginHint(dash)}
                />
              </div>

              {/* Santé des crons */}
              <div style={{ marginTop: 10 }}>
                {dash.crons.length === 0 ? (
                  <p className="muted tiny">Aucun passage de cron enregistré pour l'instant.</p>
                ) : (
                  <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                    {dash.crons.map((c) => (
                      <li key={c.name} className="tiny" style={{ display: "flex", gap: 6 }}>
                        <span title={c.ok ? "OK" : "problème"}>{c.ok ? "🟢" : "🔴"}</span>
                        <strong>{c.name}</strong>
                        <span className="muted">
                          {new Date(c.lastRunAt).toLocaleString("fr-FR", {
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                          {c.info ? ` · ${c.info}` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          )}

          <p style={{ marginBottom: 20, display: "flex", gap: 16, flexWrap: "wrap" }}>
            <Link href="/admin/membres">👥 Gérer les membres →</Link>
            <Link href="/admin/demandes">📜 Historique &amp; blocklist →</Link>
            <Link href="/admin/tricounts">💶 Tricounts →</Link>
          </p>

          {/* Demandes en attente : tâche quotidienne de l'admin → mise en avant, pleine largeur. */}
          <section style={{ ...card, marginBottom: 20 }}>
            <h2 style={{ fontSize: "1.1rem", marginTop: 0 }}>Demandes en attente</h2>
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
              <p className="muted" style={{ marginBottom: 0 }}>Aucune demande en attente.</p>
            )}

            <ul className="admin-requests" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {requests.map((r) => (
                <li
                  key={r.id}
                  style={{
                    border: "1px solid var(--pico-card-border-color, #e5e7eb)",
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
                  <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
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
                    <button
                      type="button"
                      className="secondary"
                      disabled={busyId === r.id}
                      onClick={() => act(r.id, "reject-block")}
                      style={{ color: "var(--error-fg)" }}
                    >
                      Rejeter et bloquer
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {/* Outils d'administration : cartes disposées en colonnes (masonry). columnWidth borne
              la largeur → 2 cartes de front sur PC, 1 seule sur écran étroit, sans trous de
              hauteur (chaque carte porte `breakInside: avoid`). */}
          <div style={{ columnWidth: 440, columnGap: 16 }}>
            {/* Fermeture de l'appli aux membres. Placée en tête : c'est le bouton le plus
                lourd de conséquences de cette page. */}
            <section style={masonryCard}>
              <h2 style={{ fontSize: "1.1rem", marginTop: 0 }}>Blocage de l&apos;appli</h2>
              <p className="muted tiny">
                Ferme l&apos;appli aux membres : plus de connexion (mot de passe, email et
                biométrie) ni de réservation, et un écran affichant ton message pour ceux déjà
                connectés. <strong>Les administrateurs gardent un accès complet.</strong>
              </p>
              <textarea
                aria-label="Message affiché aux membres pendant le blocage"
                placeholder="Message affiché aux membres (ex. Appli en maintenance)"
                value={blkMessage}
                maxLength={280}
                rows={2}
                disabled={blkBusy}
                onChange={(e) => setBlkMessage(e.target.value)}
                style={{ width: "100%", marginBottom: 8 }}
              />
              <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <input
                  type="checkbox"
                  role="switch"
                  checked={blkEnabled}
                  disabled={blkBusy || !blkLoaded}
                  onChange={(e) => saveBlock(e.target.checked)}
                  style={{ marginBottom: 0 }}
                />
                <span>
                  {!blkLoaded
                    ? "Lecture de l'état…"
                    : blkEnabled
                      ? "🔴 Appli fermée aux membres"
                      : "🟢 Appli ouverte à tous"}
                </span>
              </label>
              {blkEnabled && blkLoaded && (
                <p className="muted tiny" style={{ marginBottom: 8 }}>
                  Modifier le message ci-dessus ne le republie pas tout seul : rebascule le
                  switch, ou clique « Mettre à jour le message ».
                </p>
              )}
              {blkEnabled && blkLoaded && (
                <button
                  type="button"
                  className="secondary"
                  disabled={blkBusy}
                  onClick={() => saveBlock(true)}
                >
                  {blkBusy ? "…" : "Mettre à jour le message"}
                </button>
              )}
              {blkResult && (
                <div className={`notice ${blkResult.ok ? "info" : "error"}`} style={{ marginTop: 8 }}>
                  {blkResult.ok ? "✓ " : "⚠️ "}
                  {blkResult.text}
                </div>
              )}
            </section>

            {/* Pilotage à chaud des fonctions (étape #9). */}
            <div style={masonryCard}>
              <FeatureFlagsPanel />
            </div>

            {/* Annonce push à tous les membres abonnés (« Terrain fermé samedi »…). */}
            <section style={masonryCard}>
              <h2 style={{ fontSize: "1.1rem", marginTop: 0 }}>Annonce à tous les membres</h2>
              <p className="muted tiny">
                Envoie une notification push aux membres qui ont activé les notifications.
              </p>
              <input
                type="text"
                aria-label="Titre de l'annonce"
                placeholder="Titre (ex. Terrain fermé samedi)"
                value={annTitle}
                maxLength={80}
                disabled={annBusy}
                onChange={(e) => setAnnTitle(e.target.value)}
                style={{ width: "100%", marginBottom: 8 }}
              />
              <textarea
                aria-label="Message de l'annonce"
                placeholder="Message"
                value={annBody}
                maxLength={300}
                rows={3}
                disabled={annBusy}
                onChange={(e) => setAnnBody(e.target.value)}
                style={{ width: "100%", marginBottom: 8 }}
              />
              <button
                type="button"
                disabled={annBusy || !annTitle.trim() || !annBody.trim()}
                onClick={sendAnnounce}
              >
                {annBusy ? "Envoi…" : "Envoyer l'annonce"}
              </button>
              {annResult && (
                <div className={`notice ${annResult.ok ? "info" : "error"}`} style={{ marginTop: 8 }}>
                  {annResult.ok ? "✓ " : "⚠️ "}
                  {annResult.text}
                </div>
              )}
            </section>

            {/* Bannière affichée en haut de l'appli pour tous (même sans notifications). */}
            <section style={masonryCard}>
              <h2 style={{ fontSize: "1.1rem", marginTop: 0 }}>Bannière d'annonce</h2>
              <p className="muted tiny">
                Affichée en haut de l'appli pour tous. Laisse vide et « Retirer » pour l'enlever.
              </p>
              <textarea
                aria-label="Message de la bannière"
                placeholder="Message de la bannière (ex. Assemblée générale vendredi 20 h)"
                value={bnMessage}
                maxLength={280}
                rows={2}
                disabled={bnBusy}
                onChange={(e) => setBnMessage(e.target.value)}
                style={{ width: "100%", marginBottom: 8 }}
              />
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                {/* Ce select n'avait NI <label>, NI aria-label, NI placeholder : un lecteur
                    d'écran annonçait « liste » et rien d'autre. */}
                <select
                  aria-label="Niveau de la bannière"
                  value={bnLevel}
                  disabled={bnBusy}
                  onChange={(e) => setBnLevel(e.target.value as "info" | "warn")}
                  style={{ width: "auto", marginBottom: 0 }}
                >
                  <option value="info">Info (bleu)</option>
                  <option value="warn">Alerte (orange)</option>
                </select>
                <button type="button" disabled={bnBusy || !bnMessage.trim()} onClick={() => saveBanner(false)}>
                  {bnBusy ? "…" : "Enregistrer"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={bnBusy || !bnPublished}
                  onClick={() => saveBanner(true)}
                  title={bnPublished ? "Enlève l'annonce affichée" : "Aucune annonce publiée"}
                >
                  Retirer
                </button>
              </div>
              {bnResult && (
                <div className={`notice ${bnResult.ok ? "info" : "error"}`} style={{ marginTop: 8 }}>
                  {bnResult.ok ? "✓ " : "⚠️ "}
                  {bnResult.text}
                </div>
              )}
            </section>

            {/* Interclub : le roster des équipes.
                Deux populations, deux endroits, chacun là où la liste existe déjà —
                les MEMBRES se rattachent depuis la page « Membres » (un sélecteur par compte),
                les joueurs SANS COMPTE se saisissent ici. Une équipe de championnat ne coïncide
                jamais tout à fait avec la liste des inscrits sur l'appli. */}
            {interclub && (
              <section style={masonryCard}>
                <h2 style={{ fontSize: "1.1rem", marginTop: 0 }}>Équipes interclub</h2>
                <p className="muted tiny">
                  Seuls les joueurs du roster d&apos;une équipe peuvent être alignés dans ses
                  rencontres. Les membres inscrits se rattachent depuis la{" "}
                  <Link href="/admin/membres">page Membres</Link>. Ajoute ici ceux qui jouent le
                  championnat <strong>sans compte sur l&apos;appli</strong>.
                </p>

                {icTeams.length === 0 ? (
                  <p className="muted tiny">Aucune équipe en base.</p>
                ) : (
                  <>
                    {icTeams.map((t) => {
                      const mine = icGuests.filter((g) => g.teamId === t.id);
                      return (
                        <div key={t.id} style={{ marginBottom: 10 }}>
                          <div className="tiny">
                            <strong>{t.name}</strong>{" "}
                            <span className="muted">
                              · {t.memberCount} membre{t.memberCount > 1 ? "s" : ""} inscrit
                              {t.memberCount > 1 ? "s" : ""}
                              {mine.length > 0 && ` · ${mine.length} hors appli`}
                            </span>
                          </div>
                          {mine.length > 0 && (
                            <ul
                              className="tiny"
                              style={{ margin: "4px 0 0", paddingLeft: 0, listStyle: "none" }}
                            >
                              {mine.map((g) => (
                                <li
                                  key={g.id}
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    gap: 8,
                                  }}
                                >
                                  <span>{g.name}</span>
                                  <button
                                    type="button"
                                    className="secondary tiny"
                                    disabled={icBusy}
                                    onClick={() => removeGuest(g)}
                                    style={{ flex: "0 0 auto" }}
                                  >
                                    Retirer
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      );
                    })}

                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                      <select
                        value={icTeamId}
                        onChange={(e) => setIcTeamId(e.target.value)}
                        style={{ margin: 0, flex: "1 1 120px" }}
                        aria-label="Équipe du joueur à ajouter"
                      >
                        <option value="">Équipe…</option>
                        {icTeams.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                      <input
                        value={icName}
                        onChange={(e) => setIcName(e.target.value)}
                        placeholder="Prénom Nom"
                        maxLength={40}
                        aria-label="Prénom et nom du joueur hors appli"
                        style={{ margin: 0, flex: "1 1 140px" }}
                      />
                      <button
                        type="button"
                        disabled={icBusy || !icTeamId || !icName.trim()}
                        onClick={addGuest}
                        style={{ flex: "0 0 auto" }}
                      >
                        Ajouter
                      </button>
                    </div>
                  </>
                )}

                {icResult && (
                  <div className={`notice ${icResult.ok ? "info" : "error"}`} style={{ marginTop: 8 }}>
                    {icResult.ok ? "✓ " : "⚠️ "}
                    {icResult.text}
                  </div>
                )}
              </section>
            )}

            {/* Classement squashnet : rafraîchissement manuel (rattrape les nouveaux inscrits
                sans attendre le cron mensuel du 8). */}
            {ranking && (
              <section style={masonryCard}>
                <h2 style={{ fontSize: "1.1rem", marginTop: 0 }}>Classement squashnet</h2>
                <p className="muted tiny">
                  Récupère le classement fédéral de tous les membres listés dans l'annuaire. À
                  utiliser pour les nouveaux inscrits (le rafraîchissement automatique n'a lieu
                  qu'une fois par mois).
                </p>
                <button type="button" disabled={rkBusy} onClick={refreshRankings}>
                  {rkBusy ? "Récupération…" : "Rafraîchir les classements"}
                </button>
                {rkResult && (
                  <div className={`notice ${rkResult.ok ? "info" : "error"}`} style={{ marginTop: 8 }}>
                    {rkResult.ok ? "✓ " : "⚠️ "}
                    {rkResult.text}
                  </div>
                )}
              </section>
            )}
          </div>
        </>
      )}
    </main>
  );
}

// Vignette d'indicateur du tableau de bord.
function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div
      style={{
        border: "1px solid var(--pico-card-border-color, #e5e7eb)",
        borderRadius: 8,
        padding: "8px 10px",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: "1.4rem", fontWeight: 700, lineHeight: 1.1 }}>{value}</div>
      <div className="tiny">{label}</div>
      {hint && <div className="muted tiny">{hint}</div>}
    </div>
  );
}
