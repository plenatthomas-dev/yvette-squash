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
import { KNOWN_CLASSEMENTS } from "@/lib/interclub-order";

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
  // Classement fédéral EFFECTIF pour l'ordre des simples interclub (correction admin si posée,
  // sinon le rapprochement squashnet). `cltOverride` porte la correction seule, pour préremplir
  // le champ ; `cltSource` dit d'où vient `clt`, pour distinguer un rapprochement automatique
  // d'une correction déjà posée avant d'écraser l'un ou l'autre.
  clt: string | null;
  cltOverride: string | null;
  cltSource: "override" | "squashnet" | null;
  // Le RANG MIXTE, exactement de la même façon : c'est le SECOND critère de l'ordre des simples
  // (il départage deux joueurs de même classement), donc un membre non-NC qui n'en a pas ne
  // peut être aligné nulle part — d'où une correction propre, à côté de celle du classement.
  rangM: number | null;
  rangMOverride: number | null;
  rangMSource: "override" | "squashnet" | null;
  // Nom sous lequel CHERCHER ce membre sur squashnet, quand celui venu de ResaMania ne permet
  // pas de l'y retrouver. Rien à voir avec les deux corrections ci-dessus : celles-là FIGENT une
  // valeur, celui-ci répare la recherche et laisse le classement continuer de se rafraîchir.
  squashnetGivenName: string | null;
  squashnetFamilyName: string | null;
  // Faux tant que rien ne l'a jamais retrouvé sur squashnet. C'est le seul signal qui distingue
  // « pas encore classé » de « on ne le trouve pas » — sans lui, le défaut reste muet.
  squashnetMatched: boolean;
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
  | "set_team"
  | "set_clt_override"
  | "set_squashnet_name"
  | "rematch_squashnet";

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
  // Saisie EN COURS du nom de recherche squashnet, par membre. Indispensable, et pas un
  // confort : l'enregistrement exige les DEUX moitiés, or on les tape l'une après l'autre. En
  // jugeant chaque champ contre le seul état serveur, aucune des deux ne partait jamais — la
  // première parce que la seconde manquait, la seconde parce que la première n'avait pas été
  // envoyée. Le formulaire était inerte, en silence. Le brouillon les fait se voir.
  const [snDraft, setSnDraft] = useState<Record<string, { given: string; family: string }>>({});
  // Verdict du dernier rapprochement squashnet déclenché à la main, pour le membre concerné.
  const [snStatus, setSnStatus] = useState<{
    id: string;
    status: "matched" | "moved" | "unknown" | "error";
  } | null>(null);

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
    extra?: {
      passkeyId?: string;
      teamId?: string | null;
      clt?: string;
      rangM?: string;
      givenName?: string;
      familyName?: string;
    },
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
        clt?: string | null;
        rangM?: number | null;
        status?: "matched" | "moved" | "unknown" | "error";
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
      } else if (action === "set_squashnet_name" || action === "rematch_squashnet") {
        // Le brouillon a fait son office : on le retire pour que les champs repartent de ce que
        // le serveur a réellement retenu (nom normalisé, ou vide si la correction est retirée).
        if (action === "set_squashnet_name") {
          setSnDraft((d) => {
            const next = { ...d };
            delete next[id];
            return next;
          });
        }
        // Le serveur a retenté le rapprochement dans la foulée : on montre son verdict, sinon
        // l'admin aurait saisi un nom sans jamais savoir s'il était le bon avant le prochain
        // passage mensuel du cron. Puis on recharge, pour que le classement retrouvé s'affiche.
        setSnStatus({ id, status: data.status ?? "unknown" });
        await load();
      } else {
        // set_clt_override compris : contrairement à `set_team`, cette action est rare et ne
        // se répète pas vingt fois d'affilée. Effacer une correction doit alors réafficher le
        // rapprochement squashnet éventuel — une donnée que cet écran ne garde pas à part —
        // donc on recharge plutôt que de reconstruire l'état à la main.
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

  // Les deux corrections partent ENSEMBLE au serveur (une seule action), mais se règlent
  // séparément à l'écran : forcer un classement n'oblige pas à retaper un rang déjà rapproché,
  // et réciproquement. D'où la lecture de l'AUTRE valeur courante à chaque envoi — l'omettre
  // reviendrait à l'effacer, `set_clt_override` écrivant les deux colonnes.
  //
  // Retaper exactement la valeur déjà enregistrée n'écrit rien, même logique que `setTeam`.
  const setCltOverride = (id: string, clt: string) => {
    const m = members.find((x) => x.id === id);
    const next = clt.trim();
    if ((m?.cltOverride ?? "") === next) return;
    void postAction(id, "set_clt_override", {
      clt: next,
      rangM: m?.rangMOverride != null ? String(m.rangMOverride) : "",
    });
  };

  // Enregistré à la perte de focus, pas à chaque frappe : c'est un champ nombre, pas un switch.
  const setRangMOverride = (id: string, rangM: string) => {
    const m = members.find((x) => x.id === id);
    const next = rangM.trim();
    if ((m?.rangMOverride != null ? String(m.rangMOverride) : "") === next) return;
    void postAction(id, "set_clt_override", { clt: m?.cltOverride ?? "", rangM: next });
  };

  /** Ce qu'affichent les deux champs : le brouillon en cours s'il existe, sinon l'enregistré. */
  const snFields = (m: Member) =>
    snDraft[m.id] ?? { given: m.squashnetGivenName ?? "", family: m.squashnetFamilyName ?? "" };

  const editSquashnetName = (m: Member, part: "given" | "family", value: string) =>
    setSnDraft((d) => ({ ...d, [m.id]: { ...snFields(m), [part]: value } }));

  // Enregistré à la perte de focus, comme le rang : un nom passe par toutes ses initiales, et
  // partir à chaque frappe enverrait « S », « So », « Soi »…
  //
  // Les deux moitiés partent ENSEMBLE — le serveur refuse une identité amputée, qui rendrait le
  // rapprochement plus permissif que le comportement par défaut. On lit donc les DEUX champs
  // tels qu'ils sont à l'écran, brouillon compris : c'est ce que la version précédente ratait,
  // en comparant chaque moitié à un état serveur qui ne pouvait pas encore avoir bougé.
  const commitSquashnetName = (m: Member) => {
    const d = snFields(m);
    const given = d.given.trim().replace(/\s+/g, " ");
    const family = d.family.trim().replace(/\s+/g, " ");
    // Rien n'a changé par rapport à l'enregistré : ni écriture, ni rapprochement inutile.
    if (given === (m.squashnetGivenName ?? "") && family === (m.squashnetFamilyName ?? "")) return;
    // Une seule moitié : l'admin est en train de remplir l'autre champ. On n'envoie rien, mais
    // l'écran le DIT (cf. `snHalf` plus bas) — c'est ce silence-là qui a coûté un aller-retour.
    if (!!given !== !!family) return;
    setSnStatus(null);
    void postAction(m.id, "set_squashnet_name", { givenName: given, familyName: family });
  };

  /** Vrai quand une seule moitié est saisie : rien ne partira, et il faut le dire. */
  const snHalf = (m: Member) => {
    const d = snFields(m);
    return !!d.given.trim() !== !!d.family.trim();
  };

  // Retenter le rapprochement SANS toucher au nom. `setSquashnetName` ne part qu'au changement,
  // or un echec n'accuse pas toujours le nom : squashnet muet ce jour-la, licence pas encore
  // publiee, mois pas encore paru. Sans ce bouton, reessayer voudrait dire modifier le nom pour
  // le remettre aussitot.
  const rematchSquashnet = (id: string) => {
    setSnStatus(null);
    void postAction(id, "rematch_squashnet");
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

                {/* Nom de recherche sur squashnet. À LIRE AVANT le bloc suivant : quand la
                    fédération ne retrouve pas quelqu'un, le premier réflexe n'est PAS de forcer
                    son classement à la main, c'est de réparer la recherche — après quoi le
                    classement se rafraîchit tout seul chaque mois, correction comprise.
                    Le cas qui a motivé ce champ : ResaMania enregistre « Nom Prénom » ou un nom
                    mal orthographié, et l'approximation par défaut (« le nom de famille est le
                    dernier mot du nom affiché ») interroge alors la fédération sur un prénom.
                    Ce n'est PAS un renommage : `displayName` revient de ResaMania à chaque
                    connexion du membre, le corriger ici ne tiendrait pas une journée. */}
                {interclub && m.teamId && (
                  <div className="tiny" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {/* L'intitulé prend sa LIGNE, les deux champs partagent la suivante. Sur la
                        même ligne que lui, ils débordaient d'un téléphone : le second passait
                        seul à la ligne, aligné à gauche, sans plus rien qui le rattache au
                        premier — on lisait alors deux champs sans rapport l'un avec l'autre. */}
                    <span className="muted">Nom sur squashnet&nbsp;:</span>
                    <div style={{ display: "flex", gap: 6 }}>
                      {/* `flex: 1` + `minWidth: 0` : les deux champs se partagent la largeur
                          disponible quelle qu'elle soit, au lieu de deux largeurs fixes qui ne
                          tiennent que sur un écran donné.
                          `key` indexée sur la valeur enregistrée : après un rechargement, le
                          champ non contrôlé doit repartir de ce que le serveur a retenu (nom
                          normalisé, ou vide si la correction a été retirée). */}
                      <input
                        value={snFields(m).given}
                        disabled={busyId === m.id}
                        onChange={(e) => editSquashnetName(m, "given", e.target.value)}
                        onBlur={() => commitSquashnetName(m)}
                        aria-label={`Prénom sur squashnet de ${m.displayName}`}
                        placeholder="Prénom"
                        maxLength={60}
                        style={{ flex: 1, minWidth: 0, margin: 0 }}
                      />
                      <input
                        value={snFields(m).family}
                        disabled={busyId === m.id}
                        onChange={(e) => editSquashnetName(m, "family", e.target.value)}
                        onBlur={() => commitSquashnetName(m)}
                        aria-label={`Nom de famille sur squashnet de ${m.displayName}`}
                        placeholder="Nom"
                        maxLength={60}
                        style={{ flex: 1, minWidth: 0, margin: 0 }}
                      />
                    </div>

                    {/* Une seule moitié saisie : RIEN ne sera enregistré, et se taire ferait
                        croire le contraire. C'est exactement le silence qui a fait passer un
                        formulaire inerte pour un rapprochement raté. */}
                    {snHalf(m) && (
                      <span className="muted" style={{ color: "var(--warn-fg)" }}>
                        ⚠️ Donne le prénom ET le nom — rien n'est enregistré tant qu'il en manque un.
                      </span>
                    )}

                    {/* Retenter le rapprochement À LA DEMANDE. Les champs ne le déclenchent qu'au
                        CHANGEMENT du nom ; or un échec n'accuse pas toujours le nom (squashnet
                        muet ce jour-là, licence pas encore publiée, mois pas encore paru). Sans
                        ce bouton, réessayer voudrait dire modifier le nom pour le remettre
                        aussitôt. Même mot que pour un joueur sans compte, dans l'espace admin.
                        Bouton en CONTOUR : c'est une réparation, elle ne doit pas peser plus que
                        « Lien d'activation » plus bas sur la carte. */}
                    <div>
                      <button
                        type="button"
                        className="secondary"
                        disabled={busyId === m.id}
                        onClick={() => rematchSquashnet(m.id)}
                        title="Retente le rapprochement squashnet — après avoir corrigé une orthographe, par exemple."
                        style={{
                          width: "auto",
                          margin: 0,
                          padding: "3px 10px",
                          fontSize: "inherit",
                          background: "transparent",
                          borderColor: "var(--pico-muted-border-color)",
                          color: "var(--pico-contrast)",
                        }}
                      >
                        Re-rapprocher
                      </button>
                    </div>

                    {/* Le verdict du rapprochement relancé à l'instant. Il n'est affiché
                        qu'après une saisie : c'est une RÉPONSE à un geste, pas un état
                        permanent de la carte.
                        Le succès y reste à l'encre discrète : le vert est réservé à ce qui est
                        ACTIONNABLE, et un accusé de réception ne l'est pas. Seul l'échec prend
                        une couleur, parce que lui appelle un geste de plus. */}
                    {snStatus?.id === m.id && (
                      <span
                        className="muted"
                        style={
                          snStatus.status === "matched" ? undefined : { color: "var(--warn-fg)" }
                        }
                      >
                        {snStatus.status === "matched"
                          ? "✓ Retrouvé sur squashnet, classement à jour."
                          : snStatus.status === "moved"
                            ? "⚠️ Trouvé, mais hors du club : classement retiré."
                            : snStatus.status === "error"
                              ? "⚠️ Le rapprochement n'a pas pu aboutir (squashnet muet, ou écriture refusée). Le nom est enregistré : réessaie avec « Re-rapprocher »."
                              : "⚠️ Toujours introuvable. Vérifie l'orthographe, sinon force le classement ci-dessous."}
                      </span>
                    )}

                    {/* Signal PERMANENT, lui : ce membre n'a jamais été retrouvé. C'est
                        exactement ce silence qui laissait passer le défaut — un joueur qu'on
                        croyait classé et qu'aucun rapprochement n'avait jamais atteint. Tu ne
                        l'affiches pas si une correction manuelle couvre déjà le besoin. */}
                    {!m.squashnetMatched && m.cltSource !== "override" && snStatus?.id !== m.id && (
                      <span className="muted" style={{ color: "var(--warn-fg)" }}>
                        ⚠️ Jamais retrouvé sur squashnet.
                      </span>
                    )}
                  </div>
                )}

                {/* Correction du classement fédéral, pour l'ORDRE des simples interclub (le
                    mieux classé des joueurs présents joue le simple n° 1). Sert quand le
                    rapprochement squashnet a échoué ou s'est trompé — nom mal orthographié côté
                    ResaMania, licence pas encore rapprochée. `<select>` plutôt qu'un champ texte
                    libre : la liste des classements FFSquash est FERMÉE (`KNOWN_CLASSEMENTS`),
                    un texte libre laissait inventer une valeur qui n'existe pas et ne le disait
                    qu'à l'écriture — le sélecteur l'empêche dès la saisie. Enregistré au choix
                    (`onChange`), pas au tap comme le switch d'équipe au-dessus. */}
                {interclub && m.teamId && (
                  <div className="tiny" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {/* Même disposition que le nom de recherche ci-dessus, et pour la même
                        raison mesurée sur un téléphone : intitulé sur SA ligne, contrôles sur
                        la suivante. Tout sur une seule ligne, « rang&nbsp;: » restait orphelin
                        à droite du sélecteur et son champ passait seul à la ligne d'après. */}
                    <span className="muted">Classement interclub&nbsp;:</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <select
                        value={m.cltOverride ?? ""}
                        disabled={busyId === m.id}
                        onChange={(e) => setCltOverride(m.id, e.target.value)}
                        aria-label={`Classement interclub forcé pour ${m.displayName}`}
                        title="Écrase le rapprochement squashnet pour l'ordre des simples interclub. Vide = pas de correction."
                        style={{ flex: 1, minWidth: 0, margin: 0 }}
                      >
                        <option value="">
                          {m.cltSource === "squashnet" && m.clt
                            ? `— aucune (squashnet : ${m.clt}) —`
                            : "— aucune correction —"}
                        </option>
                        {KNOWN_CLASSEMENTS.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>

                      {/* Le RANG MIXTE, second critère de l'ordre des simples : à classement
                          égal, le plus petit rang joue le simple le plus petit. Champ NOMBRE et
                          non `<select>` — contrairement aux classements, les rangs ne forment
                          pas une liste fermée, ils vont à quelques milliers et bougent chaque
                          mois. Enregistré à la perte de focus (`onBlur`), pas à chaque frappe :
                          « 2339 » passerait sinon par 2, 23 et 233, trois rangs parfaitement
                          valides qui partiraient chacun au serveur.
                          Inutile pour un NC — la fédération ne les ordonne pas entre eux — d'où
                          le placeholder qui le dit plutôt qu'un champ grisé sans explication. */}
                      <span className="muted" style={{ flex: "0 0 auto" }}>
                        rang&nbsp;:
                      </span>
                      <input
                        type="number"
                        min={1}
                        inputMode="numeric"
                        defaultValue={m.rangMOverride ?? ""}
                        key={`rangm-${m.id}-${m.rangMOverride ?? ""}`}
                        disabled={busyId === m.id}
                        onBlur={(e) => setRangMOverride(m.id, e.target.value)}
                        aria-label={`Rang mixte interclub forcé pour ${m.displayName}`}
                        title="Écrase le rang mixte squashnet. Départage les joueurs de même classement. Inutile pour un NC."
                        placeholder={
                          m.rangMSource === "squashnet" && m.rangM != null
                            ? `squashnet : ${m.rangM}`
                            : m.clt === "NC"
                              ? "inutile (NC)"
                              : "aucun"
                        }
                        style={{ flex: "0 1 7.5rem", minWidth: 0, margin: 0 }}
                      />
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
