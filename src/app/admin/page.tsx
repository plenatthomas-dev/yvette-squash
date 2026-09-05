"use client";

// Espace admin (inscription sur invitation) : file d'attente des demandes de compte et de
// réinitialisation. L'accès est verrouillé CÔTÉ SERVEUR par /api/admin/requests (allowlist
// ADMIN_EMAILS) — cette page ne fait qu'afficher ce que l'API veut bien lui rendre.

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useFeatures } from "@/components/FeatureProvider";
import FeatureFlagsPanel from "@/components/FeatureFlagsPanel";
import { recheckBanner } from "@/components/AnnouncementBanner";
import { bookingOriginHint } from "@/lib/booking-origin";
import { compareRosterOrder, KNOWN_CLASSEMENTS } from "@/lib/interclub-order";

type PendingRequest = {
  id: string;
  email: string;
  purpose: "signup" | "reset";
  displayName: string | null;
  createdAt: string;
};

type CronRun = { name: string; lastRunAt: string; ok: boolean; info: string | null };

/**
 * Ce qu'il faut savoir d'un joueur pour dire s'il est alignable : son classement, son rang
 * mixte, et d'où ils viennent. Les deux populations du roster l'affichent à l'identique — un
 * membre et un joueur hors appli obéissent à la même règle, et les distinguer à l'œil ferait
 * croire le contraire.
 *
 * CE QUI MANQUE SE DIT, plutôt que de laisser un blanc. Une ligne muette ne se découvre
 * bloquante que le soir d'une rencontre, au moment de composer — trop tard pour la corriger.
 * Le rang mixte n'est réclamé qu'aux non-NC : la fédération n'ordonne pas les NC entre eux
 * (cf. `interclub-order.ts`), donc l'exiger d'eux serait un faux manque.
 */
/**
 * Ce joueur a-t-il de quoi être aligné ? Le classement ET, sauf pour un `NC`, le rang mixte —
 * les deux critères de l'ordre des simples (cf. `interclub-order.ts`). C'est ce qui décide si
 * l'écran propose la correction manuelle ou se contente d'un bouton « Actualiser » : proposer
 * d'écraser une donnée juste est une invitation à la casser, ne rien proposer sur une donnée
 * manquante est une impasse.
 */
function rankingComplete(g: { clt: string | null; rangM: number | null }): boolean {
  return g.clt != null && (g.clt === "NC" || g.rangM != null);
}

function RankingBadges({
  clt,
  rangM,
  source,
}: {
  clt: string | null;
  rangM: number | null;
  /** « squashnet » (rapproché) ou « forcé » (saisi par un admin) ; omis quand ça ne s'applique pas. */
  source?: "squashnet" | "forcé" | null;
}) {
  const rangMissing = clt != null && clt !== "NC" && rangM == null;
  return (
    <span className="ic-ranking">
      {/* CE QUI EXISTE est un badge plein ; CE QUI MANQUE est un badge en pointillé. Deux
          FORMES, pas deux nuances de gris : c'est la seule façon de repérer à l'œil, sur une
          liste de sept joueurs, celui qui ne pourra être aligné nulle part (cf. DESIGN.md,
          Règle des Trois Traitements). Le mot reste écrit — un pointillé muet serait une
          devinette. */}
      {clt ? (
        <span className="directory-clt">{clt}</span>
      ) : (
        <span className="ic-missing">classement&nbsp;?</span>
      )}
      {rangM != null ? (
        <span className="directory-rang" title="Rang national, toutes catégories">
          <span className="sr-only">Rang national toutes catégories : </span>
          <span aria-hidden="true">#</span>
          {rangM}
        </span>
      ) : rangMissing ? (
        <span className="ic-missing">rang&nbsp;?</span>
      ) : null}
      {source && <span className="ic-source">{source}</span>}
    </span>
  );
}

/** Équipe interclub et son effectif inscrit sur l'appli (l'affectation se fait page Membres). */
type IcTeam = {
  id: string;
  name: string;
  memberCount: number;
  /** Le capitaine : une désignation, pas un droit. Il est le DESTINATAIRE du récapitulatif
      des disponibilités et des alertes de calendrier — deux choses qui, envoyées à tous,
      deviendraient un bruit que chacun ignore. */
  captainId: string | null;
  captainName: string | null;
  /** L'ancrage fédéral. Les QUATRE vont ensemble (cf. `snDrawId` et `snRoundId` plus bas) :
      `snEventId` dit quoi télécharger, `snTeamId` dit lesquelles des quinze rencontres de la
      poule sont les nôtres. */
  snEventId: string | null;
  snTeamId: string | null;
  /** La POULE de l'épreuve. Sans elle, squashnet rend celle qu'il veut. */
  snRoundId: string | null;
  /** La DIVISION. Elle ne sert pas au calendrier mais au CLASSEMENT. */
  snDrawId: string | null;
  /** Dernier relevé du classement, pour distinguer « à jour » de « figé ». */
  snStandingsAt: string | null;
  /** Dernier contrôle du calendrier. Il répond à la question que le silence ne tranche pas :
      « rien n'a bougé », ou « on n'a pas regardé » ? */
  snCheckedAt: string | null;
};

/** Un champ du calendrier qui a bougé, dans ses deux versions. */
type CalChange = { field: string; from: string | null; to: string | null };
/** Une rencontre telle que la ligue la publie. */
type CalTie = {
  round: string;
  date: string;
  time: string | null;
  home: boolean;
  opponent: string;
  venue: string | null;
  venueAddress: string | null;
  dateConfirmed: boolean;
};
/** Ce que rend la PRÉVISUALISATION : ce qui serait écrit, avant de l'écrire. */
type CalPreview = {
  teamId: string;
  teamName: string;
  published: number;
  toCreate: CalTie[];
  toUpdate: { id: string; tie: CalTie; changes: CalChange[] }[];
  /** Journées importées de cet événement que la ligue ne publie PLUS. Signalées, jamais
      supprimées : une rencontre peut déjà porter une composition et des réponses. */
  toDelete: { id: string; round: string | null; date: string; opponent: string }[];
  /**
   * Journées dont le STATUT DE LA DATE diverge. Signalées, jamais écrites : « confirmée » est
   * une déduction, et l'admin est justement celui qui la corrige quand elle se trompe. La
   * réappliquer révoquerait sa correction, et l'équipe cesserait d'être convoquée.
   */
  confirmDrift: { id: string; round: string; stored: boolean; published: boolean }[];
  /** Journées dont la date NE BOUGERA PAS : la rencontre est déjà commencée. */
  frozen: string[];
  unchanged: number;
  /**
   * L'empreinte du calendrier tel qu'il vient d'être MONTRÉ, renvoyée avec l'application.
   *
   * Les deux temps ne tenaient l'un à l'autre par rien : `apply` retélécharge et recalcule.
   * Prévisualiser, s'absenter, revenir cliquer « Appliquer » validait donc un écart qu'on
   * n'avait jamais lu — y compris un effacement de disponibilités.
   */
  seen: string | null;
};

/**
 * CE QUI MANQUE À L'ANCRAGE, nommé — ou null s'il est complet.
 *
 * Les quatre identifiants ne servent pas à la même chose et ne se devinent pas l'un l'autre :
 * une infobulle qui n'en teste qu'un promet une action sur un bouton mort.
 */
function ancrageManquant(t: {
  snEventId: string | null;
  snDrawId: string | null;
  snRoundId: string | null;
  snTeamId: string | null;
}): string | null {
  const manque = [
    !t.snEventId && "l'épreuve",
    !t.snDrawId && "la division",
    !t.snRoundId && "la poule",
    !t.snTeamId && "l'équipe",
  ].filter((x): x is string => typeof x === "string");
  return manque.length === 0 ? null : `Renseigne d'abord ${manque.join(", ")}.`;
}

/** Les champs du calendrier, en français : l'écran ne parle pas le nom de colonne. */
const CAL_FIELDS: Record<string, string> = {
  date: "date",
  time: "heure",
  home: "réception",
  opponent: "adversaire",
  venue: "lieu",
  venueAddress: "adresse",
};

/** Une valeur d'écart, rendue lisible — un booléen brut ne dit rien à personne. */
function calValue(field: string, v: string | null): string {
  if (v === null || v === "") return "—";
  if (field === "home") return v === "true" ? "à domicile" : "à l'extérieur";
  return v;
}
/** Membre inscrit rattaché à une équipe : listé ici en LECTURE (rattachement page Membres). */
type IcMember = { id: string; teamId: string; name: string; clt: string | null; rangM: number | null };
/**
 * Joueur d'une équipe SANS compte : il joue le championnat sans utiliser l'appli — souvent
 * délibérément (« je ne veux pas de l'appli, mais je veux bien y figurer »).
 *
 * `clt`/`rangM` sont les valeurs EFFECTIVES, celles qui décident de l'ordre des simples.
 * `cltOverride`/`rangMOverride` portent la seule saisie admin, pour préremplir les champs sans
 * transformer un rapprochement en correction au premier enregistrement. `snStatus` dit ce que
 * squashnet a répondu la dernière fois — c'est lui qui permet d'écrire « pas trouvable » au
 * lieu de laisser une ligne muette dont on découvre le soir venu qu'elle bloque la composition.
 */
type IcGuest = {
  id: string;
  teamId: string;
  name: string;
  clt: string | null;
  rangM: number | null;
  cltOverride: string | null;
  rangMOverride: number | null;
  snClt: string | null;
  snRangM: number | null;
  snStatus: string | null;
  snCheckedAt: string | null;
};
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

/**
 * UNE TUILE VERS UNE AUTRE PAGE DE L'ADMIN.
 *
 * Trois liens nus posés sur la page ne disaient ni où ils mènent ni ce qu'on y trouve —
 * « Historique & blocklist » ne renseigne que celui qui connaît déjà la page. La tuile a la
 * place d'écrire la phrase, et se vise au pouce plutôt qu'au pixel.
 *
 * Le chevron est décoratif : le lien porte déjà son libellé, et un lecteur d'écran qui
 * annoncerait « flèche vers la droite » n'apprendrait rien de plus.
 */
function PageLien({
  href,
  icone,
  titre,
  quoi,
}: {
  href: string;
  icone: string;
  titre: string;
  quoi: string;
}) {
  return (
    <Link className="adm-lien" href={href}>
      <span className="adm-lien-icone" aria-hidden="true">
        {icone}
      </span>
      <span className="adm-lien-titre">
        {titre}
        <span className="adm-lien-quoi">{quoi}</span>
      </span>
      <span className="adm-lien-fleche" aria-hidden="true">
        →
      </span>
    </Link>
  );
}

/**
 * UN GROUPE D'OPTIONS, et le filet qui dit ce qu'il touche.
 *
 * Cette page alignait sept cartes identiques dans une seule coulée : même encadré, même
 * titre, aucun regroupement. Rien ne distinguait le bouton qui ferme l'appli à tout le club
 * de celui qui corrige l'orthographe d'un roster, et trouver « Bannière d'annonce »
 * demandait de lire les sept titres.
 *
 * Le `ton` n'est pas décoratif — DESIGN.md interdit la couleur qui ne dit rien. Il répond à
 * la seule question qu'on se pose devant un réglage d'admin : QUI VERRA ÇA ?
 *
 *   `critique`  → ce levier retire quelque chose aux membres, tout de suite et pour tous ;
 *   `diffusion` → ce qui part d'ici sort du club et ne se reprend pas ;
 *   `config`    → réglage interne, réversible, sans effet visible immédiat.
 *
 * La `portee` redit en toutes lettres ce que le filet suggère : la couleur ne porte jamais
 * seule une information, et l'icône fait le troisième rappel.
 *
 * ⚠️ Le `<h2>` appartient au GROUPE ; les cartes qu'il contient portent des `<h3>`. C'est la
 * hiérarchie qui manquait au lecteur d'écran, à qui sept titres de même niveau ne disaient
 * rien de leur parenté.
 */
function Groupe({
  ton,
  titre,
  icone,
  portee,
  large,
  children,
}: {
  ton: "critique" | "diffusion" | "config";
  titre: string;
  icone: string;
  portee: string;
  /** Une seule colonne : pour un contenu que 440px étrangleraient (cf. `.adm-cartes-large`). */
  large?: boolean;
  children: ReactNode;
}) {
  const id = `adm-groupe-${ton}`;
  return (
    <section className={`adm-groupe adm-groupe-${ton}`} aria-labelledby={id}>
      <h2 className={`adm-groupe-titre adm-groupe-${ton}`} id={id}>
        <span className="adm-groupe-icone" aria-hidden="true">
          {icone}
        </span>
        <span>{titre}</span>
        {/* Sans séparateur : sur écran étroit la mention passe à la ligne, et un « · » de tête
            s'y lirait comme une puce. */}
        <span className="adm-groupe-portee">{portee}</span>
      </h2>
      <div className={large ? "adm-cartes adm-cartes-large" : "adm-cartes"}>{children}</div>
    </section>
  );
}

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
  const [icMembers, setIcMembers] = useState<IcMember[]>([]);
  const [icGuests, setIcGuests] = useState<IcGuest[]>([]);
  const [icTeamId, setIcTeamId] = useState("");
  // L'ancrage se saisit en BROUILLON, une entrée par équipe, et ne part qu'au bouton.
  //
  // Ce n'est pas de la prudence d'écran mais une leçon déjà payée : les identifiants
  // partent ENSEMBLE ou pas du tout (le serveur refuse un seul des deux), et une comparaison
  // à l'état SERVEUR pour décider quoi envoyer ne peut jamais être vraie — rien n'a encore
  // été écrit. Le même raisonnement avait rendu inerte la saisie du nom squashnet d'un membre.
  const [icAnchor, setIcAnchor] = useState<
    Record<string, { eventId: string; drawId: string; roundId: string; snTeamId: string }>
  >({});
  const [icCal, setIcCal] = useState<CalPreview | null>(null);
  /**
   * L'équipe dont un import est EN COURS, ou null.
   *
   * Un booléen global faisait passer le bouton de TOUTES les équipes en « … » dès qu'on
   * prévisualisait l'import de l'une d'elles : l'écran annonçait trois travaux là où il n'y en
   * avait qu'un, et on ne savait plus lequel on attendait. Les boutons des autres équipes
   * restent désactivés — on n'importe qu'une équipe à la fois —, mais ils le disent autrement.
   */
  const [icCalBusy, setIcCalBusy] = useState<string | null>(null);
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
      const data = (await res.json()) as { teams: IcTeam[]; members: IcMember[]; guests: IcGuest[] };
      setIcTeams(data.teams);
      setIcMembers(data.members ?? []);
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
      const data = (await res.json().catch(() => ({}))) as {
        guest?: IcGuest;
        status?: string;
        error?: string;
      };
      if (!res.ok || !data.guest) {
        setIcResult({ ok: false, text: data.error ?? "Ajout impossible." });
        return;
      }
      setIcGuests((prev) => [...prev, data.guest!].sort((a, b) => a.name.localeCompare(b.name, "fr")));
      setIcName("");
      // Le serveur a déjà cherché ce joueur sur squashnet : on RAPPORTE le verdict au lieu de
      // dire « ajouté » et de laisser l'admin découvrir plus tard qu'il manque un classement.
      // C'est le seul moment où le nom est encore sous ses yeux, donc le seul où « pas trouvé »
      // est actionnable (corriger l'orthographe, ou forcer le classement).
      setIcResult(
        data.status === "matched"
          ? { ok: true, text: `${data.guest.name} ajouté — classement ${data.guest.clt ?? "?"} rapproché sur squashnet.` }
          : {
              ok: false,
              text: `${data.guest.name} ajouté, mais introuvable sur squashnet : vérifie l'orthographe et re-rapproche, ou saisis son classement et son rang à la main.`,
            },
      );
    } catch {
      setIcResult({ ok: false, text: "Ajout impossible." });
    } finally {
      setIcBusy(false);
    }
  };

  /**
   * Correction manuelle d'un invité — le REPLI quand squashnet ne sait pas le retrouver.
   *
   * Les deux critères partent ENSEMBLE (le serveur écrit les deux colonnes), mais se règlent
   * séparément à l'écran : corriger un classement n'oblige pas à retaper un rang. D'où
   * `patch`, qui ne porte QUE le champ modifié — l'autre est relu sur la ligne courante, car
   * l'omettre l'effacerait. Même geste que la page Membres, où la correction d'un membre suit
   * exactement la même mécanique.
   *
   * Comparaison sur l'OVERRIDE et non sur la valeur effective : rejouer un rapprochement en le
   * renvoyant tel quel le figerait en correction, et le prochain run mensuel ne pourrait plus
   * le mettre à jour.
   */
  const setGuestRanking = async (
    g: IcGuest,
    patch: { clt?: string; rangM?: string },
  ) => {
    const clt = (patch.clt ?? g.cltOverride ?? "").trim();
    const rangM = (patch.rangM ?? (g.rangMOverride != null ? String(g.rangMOverride) : "")).trim();
    if (clt === (g.cltOverride ?? "") && rangM === (g.rangMOverride != null ? String(g.rangMOverride) : "")) {
      return;
    }
    setIcBusy(true);
    setIcResult(null);
    try {
      const res = await fetch("/api/admin/interclub-teams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_guest_ranking", guestId: g.id, clt, rangM }),
      });
      const data = (await res.json().catch(() => ({}))) as { guest?: IcGuest; error?: string };
      if (!res.ok || !data.guest) {
        setIcResult({ ok: false, text: data.error ?? "Enregistrement impossible." });
        return;
      }
      setIcGuests((prev) => prev.map((x) => (x.id === g.id ? data.guest! : x)));
    } catch {
      setIcResult({ ok: false, text: "Enregistrement impossible." });
    } finally {
      setIcBusy(false);
    }
  };

  /**
   * Retente le rapprochement squashnet d'un seul invité. Utile juste après avoir corrigé
   * l'orthographe d'un nom, ou quand une licence vient d'être enregistrée côté fédération : le
   * cron mensuel y arriverait, mais pas avant le prochain jeudi de championnat.
   */
  const rematchGuest = async (g: IcGuest) => {
    setIcBusy(true);
    setIcResult(null);
    try {
      const res = await fetch("/api/admin/interclub-teams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rematch_guest", guestId: g.id }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        guest?: IcGuest;
        status?: string;
        error?: string;
      };
      if (!res.ok || !data.guest) {
        setIcResult({ ok: false, text: data.error ?? "Rapprochement impossible." });
        return;
      }
      setIcGuests((prev) => prev.map((x) => (x.id === g.id ? data.guest! : x)));
      setIcResult(
        data.status === "matched"
          ? { ok: true, text: `${g.name} : classement ${data.guest.snClt ?? "?"} rapproché sur squashnet.` }
          : { ok: false, text: `${g.name} : toujours introuvable sur squashnet.` },
      );
    } catch {
      setIcResult({ ok: false, text: "Rapprochement impossible." });
    } finally {
      setIcBusy(false);
    }
  };

  /**
   * Nomme (ou retire, `userId` vide) le capitaine. Le serveur refuse un membre qui ne joue pas
   * dans l'équipe : c'est presque toujours une erreur de saisie, et le laisser passer donnerait
   * un destinataire d'alertes qui ne se sent pas concerné — donc des alertes que personne ne
   * traite. On se contente ici de RAPPORTER ce refus.
   */
  const setCaptain = async (t: IcTeam, userId: string) => {
    setIcBusy(true);
    setIcResult(null);
    try {
      const res = await fetch("/api/admin/interclub-teams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_captain", teamId: t.id, userId: userId || null }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setIcResult({ ok: false, text: data.error ?? "Désignation impossible." });
        return;
      }
      const name = userId ? (icMembers.find((m) => m.id === userId)?.name ?? null) : null;
      setIcTeams((prev) =>
        prev.map((x) => (x.id === t.id ? { ...x, captainId: userId || null, captainName: name } : x)),
      );
      setIcResult({
        ok: true,
        text: name ? `${name} est capitaine de ${t.name}.` : `${t.name} n'a plus de capitaine.`,
      });
    } catch {
      setIcResult({ ok: false, text: "Désignation impossible." });
    } finally {
      setIcBusy(false);
    }
  };

  /** Les quatre identifiants du brouillon, ou l'ancrage enregistré tant qu'on n'a rien tapé. */
  const anchorFields = (t: IcTeam) =>
    icAnchor[t.id] ?? {
      eventId: t.snEventId ?? "",
      drawId: t.snDrawId ?? "",
      roundId: t.snRoundId ?? "",
      snTeamId: t.snTeamId ?? "",
    };

  const editAnchor = (
    t: IcTeam,
    patch: { eventId?: string; drawId?: string; roundId?: string; snTeamId?: string },
  ) => setIcAnchor((prev) => ({ ...prev, [t.id]: { ...anchorFields(t), ...patch } }));

  const saveAnchor = async (t: IcTeam) => {
    const { eventId, drawId, roundId, snTeamId } = anchorFields(t);
    setIcBusy(true);
    setIcResult(null);
    try {
      const res = await fetch("/api/admin/interclub-teams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set_squashnet_event",
          teamId: t.id,
          eventId,
          drawId,
          roundId,
          snTeamId,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setIcResult({ ok: false, text: data.error ?? "Enregistrement impossible." });
        return;
      }
      setIcTeams((prev) =>
        prev.map((x) =>
          x.id === t.id
            ? {
                ...x,
                snEventId: eventId || null,
                snDrawId: drawId || null,
                snRoundId: roundId || null,
                snTeamId: snTeamId || null,
                snCheckedAt: null,
                // Changer d'ancrage périme le classement de l'ancienne poule, que le serveur
                // vient d'effacer : l'écran doit dire la même chose que la base.
                snStandingsAt: null,
              }
            : x,
        ),
      );
      // Le brouillon est repris par l'état serveur : le garder ferait diverger silencieusement
      // les deux le jour où le serveur normalise une valeur.
      setIcAnchor((prev) => {
        const next = { ...prev };
        delete next[t.id];
        return next;
      });
      // Changer d'ancrage périme l'aperçu affiché : il porte sur l'ancien championnat.
      if (icCal?.teamId === t.id) setIcCal(null);
      setIcResult({
        ok: true,
        text: eventId ? `${t.name} est rattachée à son championnat.` : `${t.name} n'est plus rattachée.`,
      });
    } catch {
      setIcResult({ ok: false, text: "Enregistrement impossible." });
    } finally {
      setIcBusy(false);
    }
  };

  /**
   * L'import se fait en DEUX TEMPS. Ce qu'il écrit n'est pas une donnée d'affichage : c'est la
   * date à laquelle une équipe se déplace, et appliquer un écart de date efface les
   * disponibilités déjà recueillies. On regarde d'abord, on applique ensuite.
   */
  /**
   * Retélécharge le CLASSEMENT de la poule tout de suite.
   *
   * La passe hebdomadaire le fait déjà, mais elle passe le lundi : sans ce bouton, celui qui
   * vient de saisir l'ancrage attendrait jusqu'à six jours pour découvrir qu'il s'est trompé de
   * division — et une division fausse rend le tableau d'une AUTRE poule, parfaitement crédible.
   */
  const refreshStandings = async (t: IcTeam) => {
    setIcCalBusy(t.id);
    setIcResult(null);
    try {
      const res = await fetch("/api/admin/interclub-calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "standings", teamId: t.id }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        rows?: number;
        standingsAt?: string;
        error?: string;
      };
      if (!res.ok) {
        setIcResult({ ok: false, text: data.error ?? "Classement indisponible." });
        return;
      }
      setIcResult({ ok: true, text: `Classement à jour — ${data.rows} équipe(s).` });
      setIcTeams((prev) =>
        prev.map((x) =>
          x.id === t.id ? { ...x, snStandingsAt: data.standingsAt ?? null } : x,
        ),
      );
    } catch {
      setIcResult({ ok: false, text: "Réseau indisponible." });
    } finally {
      setIcCalBusy(null);
    }
  };

  const previewCalendar = async (t: IcTeam) => {
    setIcCalBusy(t.id);
    setIcResult(null);
    setIcCal(null);
    try {
      const res = await fetch("/api/admin/interclub-calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "preview", teamId: t.id }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<CalPreview> & { error?: string };
      if (!res.ok) {
        setIcResult({ ok: false, text: data.error ?? "Récupération impossible." });
        return;
      }
      setIcCal({
        teamId: t.id,
        teamName: data.teamName ?? t.name,
        published: data.published ?? 0,
        toCreate: data.toCreate ?? [],
        toUpdate: data.toUpdate ?? [],
        toDelete: data.toDelete ?? [],
        confirmDrift: data.confirmDrift ?? [],
        frozen: data.frozen ?? [],
        unchanged: data.unchanged ?? 0,
        seen: data.seen ?? null,
      });
    } catch {
      setIcResult({ ok: false, text: "Récupération impossible." });
    } finally {
      setIcCalBusy(null);
    }
  };

  const applyCalendar = async (t: IcTeam) => {
    setIcCalBusy(t.id);
    setIcResult(null);
    try {
      const res = await fetch("/api/admin/interclub-calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `seen` : ce que l'aperçu a montré. Le serveur refuse plutôt que d'appliquer autre
        // chose si la ligue a publié entre les deux clics.
        body: JSON.stringify({ action: "apply", teamId: t.id, seen: icCal?.seen ?? undefined }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        created?: number;
        updated?: number;
        moved?: number;
        vanished?: number;
        frozen?: string[];
        error?: string;
      };
      if (!res.ok) {
        setIcResult({ ok: false, text: data.error ?? "Import impossible." });
        return;
      }
      setIcCal(null);
      setIcTeams((prev) =>
        prev.map((x) => (x.id === t.id ? { ...x, snCheckedAt: new Date().toISOString() } : x)),
      );
      setIcResult({
        ok: true,
        text:
          `${t.name} : ${data.created ?? 0} rencontre(s) créée(s), ${data.updated ?? 0} corrigée(s)` +
          (data.moved
            ? ` — ${data.moved} déplacée(s), l'équipe est prévenue et leurs disponibilités sont remises à zéro`
            : "") +
          (data.frozen?.length
            ? ` — ${data.frozen.join(", ")} gardée(s) à sa date : la rencontre est commencée`
            : "") +
          (data.vanished
            ? ` — ${data.vanished} journée(s) ne sont plus publiées : à vérifier et à supprimer à la main`
            : "") +
          ".",
      });
    } catch {
      setIcResult({ ok: false, text: "Import impossible." });
    } finally {
      setIcCalBusy(null);
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
        <div className="adm-carte">
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
            <section className="adm-carte" style={{ marginBottom: 18 }}>
              {/* HORS GROUPE, et en tête : on le lit, on n'y touche pas. Lui donner un filet de
                  portée serait mentir — il ne règle rien. */}
              <h2 className="adm-carte-titre">📊 Tableau de bord</h2>
              <div className="adm-stats">
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

          {/* Les autres pages de l'admin. Ce ne sont pas des options : elles n'ont donc pas de
              filet de portée — mais elles mènent quelque part, et une tuile le dit mieux qu'un
              lien souligné. La ligne de dessous existe parce que le libellé seul ne renseigne
              que celui qui connaît déjà la page. */}
          <nav className="adm-liens" aria-label="Autres pages d'administration">
            <PageLien
              href="/admin/membres"
              icone="👥"
              titre="Membres"
              quoi="Rattacher, désactiver, rapprocher sur squashnet"
            />
            <PageLien
              href="/admin/demandes"
              icone="📜"
              titre="Historique"
              quoi="Demandes déjà traitées et adresses bloquées"
            />
            <PageLien
              href="/admin/tricounts"
              icone="💶"
              titre="Tricounts"
              quoi="Les dépenses partagées de tous les groupes"
            />
          </nav>

          {/* Demandes en attente : tâche quotidienne de l'admin → mise en avant, pleine largeur.
              Hors groupe elle aussi : ce n'est pas un réglage mais du travail à faire. */}
          <section className="adm-carte" style={{ marginBottom: 18 }}>
            <h2 className="adm-carte-titre">📥 Demandes en attente</h2>
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

            <ul className="admin-requests">
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

          {/* LES TROIS GROUPES, par conséquence décroissante. « Blocage de l'appli » ouvre le
              premier : c'est le bouton le plus lourd de conséquences de cette page. */}
          <Groupe
            ton="critique"
            icone="🔒"
            titre="Accès et fonctions"
            portee="retire quelque chose à tous les membres, tout de suite"
          >
            <section className="adm-carte">
              <h3 className="adm-carte-titre">Blocage de l&apos;appli</h3>
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

            {/* Pilotage à chaud des fonctions (étape #9). Même groupe que le blocage : couper
                une fonction, c'est la retirer à tout le monde sans préavis. */}
            <div className="adm-carte">
              <FeatureFlagsPanel />
            </div>
          </Groupe>

          <Groupe
            ton="diffusion"
            icone="📣"
            titre="Diffusion"
            portee="sort du club et ne se reprend pas"
          >
            {/* Annonce push à tous les membres abonnés (« Terrain fermé samedi »…). */}
            <section className="adm-carte">
              <h3 className="adm-carte-titre">Annonce à tous les membres</h3>
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
            <section className="adm-carte">
              <h3 className="adm-carte-titre">Bannière d&apos;annonce</h3>
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

          </Groupe>

          {/* Une seule colonne : la carte des équipes porte des formulaires imbriqués que
              440px étrangleraient. */}
          <Groupe
            ton="config"
            icone="🏆"
            titre="Interclub"
            portee="réglage interne, réversible"
            large
          >
            {/* Interclub : le roster des équipes.
                Deux populations, deux endroits, chacun là où la liste existe déjà —
                les MEMBRES se rattachent depuis la page « Membres » (un sélecteur par compte),
                les joueurs SANS COMPTE se saisissent ici. Une équipe de championnat ne coïncide
                jamais tout à fait avec la liste des inscrits sur l'appli. */}
            {interclub && (
              <section className="adm-carte">
                <h3 className="adm-carte-titre">Équipes interclub</h3>
                <p className="muted tiny">
                  Seuls les joueurs du roster d&apos;une équipe peuvent être alignés dans ses
                  rencontres. Les membres inscrits se rattachent depuis la{" "}
                  <Link href="/admin/membres">page Membres</Link>. Ajoute ici ceux qui jouent le
                  championnat <strong>sans compte sur l&apos;appli</strong> : leur classement est
                  cherché sur squashnet à l&apos;ajout, et tu ne le saisis à la main que si la
                  fédération ne les retrouve pas.
                </p>
                <p className="muted tiny">
                  L&apos;ordre des simples se décide sur <strong>deux</strong> critères : le
                  classement d&apos;abord, puis le <strong>rang mixte</strong> entre joueurs de
                  même classement. Un joueur à qui il manque l&apos;un des deux ne peut être
                  aligné nulle part — sauf un NC, que la fédération n&apos;ordonne pas.
                </p>

                {icTeams.length === 0 ? (
                  <p className="muted tiny">Aucune équipe en base.</p>
                ) : (
                  <>
                    {icTeams.map((t) => {
                      const mine = icGuests.filter((g) => g.teamId === t.id);
                      const siens = icMembers.filter((m) => m.teamId === t.id);
                      // L'EFFECTIF RÉEL de l'équipe : membres inscrits ET joueurs hors appli
                      // dans une seule liste, triée du MIEUX au MOINS bien classé
                      // (`compareRosterOrder`, le même comparateur que le sélecteur de
                      // composition et que les têtes de série du tournoi). C'est l'ordre dans
                      // lequel ces joueurs devront disputer les simples : le lire ici, c'est
                      // voir d'un coup d'œil si l'équipe tient debout. Les deux listes arrivent
                      // déjà triées par nom du serveur, ce qui fournit le départage alphabétique
                      // des ex æquo (tri stable).
                      const effectif = [
                        ...siens.map((m) => ({ kind: "member" as const, m })),
                        ...mine.map((g) => ({ kind: "guest" as const, g })),
                      ].sort((a, b) =>
                        compareRosterOrder(
                          a.kind === "member"
                            ? { name: a.m.name, clt: a.m.clt, rangM: a.m.rangM }
                            : { name: a.g.name, clt: a.g.clt, rangM: a.g.rangM },
                          b.kind === "member"
                            ? { name: b.m.name, clt: b.m.clt, rangM: b.m.rangM }
                            : { name: b.g.name, clt: b.g.clt, rangM: b.g.rangM },
                        ),
                      );
                      return (
                        <div key={t.id} className="ic-team">
                          {/* L'en-tête d'équipe porte le nom en poids, le décompte en gris : à
                              trois équipes empilées, c'est le seul repère qui permet de savoir
                              où l'on est en défilant. */}
                          <div className="ic-team-head">
                            <span className="ic-team-name">{t.name}</span>
                            <span className="ic-team-count muted">
                              {t.memberCount} membre{t.memberCount > 1 ? "s" : ""}
                              {mine.length > 0 && ` · ${mine.length} hors appli`}
                            </span>
                          </div>
                          {effectif.length === 0 ? (
                            <p className="muted tiny ic-roster-empty">
                              Personne dans cette équipe pour l&apos;instant.
                            </p>
                          ) : (
                            <ul className="ic-roster">
                              {effectif.map((e) =>
                                e.kind === "member" ? (
                                  // Un MEMBRE se lit ici, il ne s'édite pas : son rattachement et
                                  // la correction de son classement vivent sur la page Membres,
                                  // où la liste des comptes existe déjà — deux endroits pour la
                                  // même décision, c'est un endroit de trop. Sans classement
                                  // connu, il ne peut disputer AUCUN simple : on le DIT, plutôt
                                  // que de laisser une ligne muette qui bloquera le soir venu.
                                  <li key={`m${e.m.id}`} className="ic-roster-row">
                                    <span className="ic-roster-name">{e.m.name}</span>
                                    <RankingBadges clt={e.m.clt} rangM={e.m.rangM} />
                                  </li>
                                ) : (
                                  // Un joueur HORS APPLI s'édite, lui — d'où la surface enfoncée
                                  // (`--sunken`) : sur une liste où membres et invités se
                                  // ressemblent par ailleurs, elle dit d'un coup d'œil sur
                                  // lesquels on peut agir, sans recourir à la couleur. Les
                                  // contrôles vont sur LEUR PROPRE LIGNE, sous le nom : les
                                  // mettre au bout de la ligne du nom faisait s'enrouler quatre
                                  // éléments sur un téléphone, et les badges d'un joueur
                                  // finissaient à hauteur du nom du précédent.
                                  <li key={`g${e.g.id}`} className="ic-roster-row is-guest">
                                    <span className="ic-roster-name">
                                      {e.g.name}
                                      <span className="ic-roster-tag">hors appli</span>
                                    </span>
                                    <RankingBadges
                                      clt={e.g.clt}
                                      rangM={e.g.rangM}
                                      source={e.g.cltOverride ? "forcé" : e.g.snStatus === "matched" ? "squashnet" : null}
                                    />
                                    <span className="ic-roster-actions">
                                      {/* Le rapprochement squashnet est la voie NORMALE ; ce qui
                                          suit est le repli, et l'écran le dit dans cet ordre.
                                          Un joueur retrouvé n'a rien à saisir — on ne montre les
                                          champs de correction que lorsqu'ils servent, faute de
                                          quoi ils invitent à écraser une donnée juste.

                                          « Servent » veut bien dire : rapprochement RATÉ,
                                          correction DÉJÀ posée, OU rapprochement réussi mais
                                          INCOMPLET. Ce dernier cas est réel — squashnet publie
                                          des lignes sans rang mixte — et n'ouvrir les champs
                                          que sur `snStatus` y laissait un joueur inalignable
                                          sans le moindre moyen de le corriger. */}
                                      {rankingComplete(e.g) && !e.g.cltOverride && !e.g.rangMOverride ? (
                                        <button
                                          type="button"
                                          className="secondary"
                                          disabled={icBusy}
                                          onClick={() => rematchGuest(e.g)}
                                          title="Relit le classement sur squashnet (le cron le fait aussi, une fois par mois)."
                                        >
                                          Actualiser
                                        </button>
                                      ) : (
                                        <>
                                          {/* `<select>` plutôt qu'un champ texte libre : la liste
                                              des classements FFSquash est FERMÉE
                                              (`KNOWN_CLASSEMENTS`), un texte libre laissait
                                              inventer une valeur qui n'existe pas. */}
                                          <select
                                            value={e.g.cltOverride ?? ""}
                                            disabled={icBusy}
                                            onChange={(ev) => setGuestRanking(e.g, { clt: ev.target.value })}
                                            aria-label={`Classement interclub de ${e.g.name}`}
                                            title="Classement fédéral forcé, pour l'ordre des simples interclub."
                                          >
                                            <option value="">
                                              {e.g.snClt ? `— squashnet : ${e.g.snClt} —` : "— aucun —"}
                                            </option>
                                            {KNOWN_CLASSEMENTS.map((c) => (
                                              <option key={c} value={c}>
                                                {c}
                                              </option>
                                            ))}
                                          </select>
                                          {/* Champ NOMBRE et non `<select>` : les rangs ne forment
                                              pas une liste fermée. Enregistré à la perte de focus,
                                              pas à chaque frappe — « 2339 » passerait sinon par 2,
                                              23 et 233, trois rangs parfaitement valides. */}
                                          <input
                                            type="number"
                                            min={1}
                                            inputMode="numeric"
                                            defaultValue={e.g.rangMOverride ?? ""}
                                            key={`grangm-${e.g.id}-${e.g.rangMOverride ?? ""}`}
                                            disabled={icBusy}
                                            onBlur={(ev) => setGuestRanking(e.g, { rangM: ev.target.value })}
                                            aria-label={`Rang mixte de ${e.g.name}`}
                                            title="Rang mixte forcé. Départage les joueurs de même classement. Inutile pour un NC."
                                            placeholder={
                                              e.g.snRangM != null ? `#${e.g.snRangM}` : e.g.clt === "NC" ? "inutile" : "rang"
                                            }
                                          />
                                          <button
                                            type="button"
                                            className="secondary"
                                            disabled={icBusy}
                                            onClick={() => rematchGuest(e.g)}
                                            title="Retente le rapprochement squashnet — après avoir corrigé une orthographe, par exemple."
                                          >
                                            Re-rapprocher
                                          </button>
                                        </>
                                      )}
                                      <button
                                        type="button"
                                        className="danger"
                                        disabled={icBusy}
                                        onClick={() => removeGuest(e.g)}
                                      >
                                        Retirer
                                      </button>
                                    </span>
                                  </li>
                                ),
                              )}
                            </ul>
                          )}

                          {/* --- Capitaine et calendrier fédéral ---------------------------
                              Deux réglages qui appartiennent à l'ÉQUIPE et non à un joueur :
                              ils vivent donc sous son effectif, une fois qu'on sait de qui
                              elle est faite. Le capitaine se voit toujours — c'est une
                              information, et son absence en est une aussi ; la machinerie
                              d'import se replie, parce qu'on la règle une fois par saison. */}
                          <div className="ic-team-admin">
                            <label className="ic-cap">
                              <span className="ic-cap-label">Capitaine</span>
                              <select
                                value={t.captainId ?? ""}
                                disabled={icBusy || siens.length === 0}
                                onChange={(ev) => setCaptain(t, ev.target.value)}
                                title="Il reçoit le récapitulatif des disponibilités et les alertes de calendrier. Il n'a aucun droit de plus."
                              >
                                <option value="">— aucun —</option>
                                {siens.map((m) => (
                                  <option key={m.id} value={m.id}>
                                    {m.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                            {/* LE CAPITAINE ENREGISTRÉ, quand le sélecteur ne peut pas le
                                montrer. Le sélecteur ne liste que les membres de l'équipe :
                                un capitaine rattaché ailleurs depuis n'y a plus d'option, et le
                                navigateur retombe sur la première — « — aucun — ». L'admin en
                                concluait qu'il n'y avait pas de capitaine, alors que `captainId`
                                était toujours renseigné et que le cron continuait d'écrire à
                                cette personne. On montre l'incohérence au lieu de la masquer.
                                La cause racine est réglée côté `set_team`, qui démet du brassard
                                qu'on quitte ; ceci rattrape les équipes ancrées avant. */}
                            {t.captainId && !siens.some((m) => m.id === t.captainId) && (
                              <p className="muted tiny">
                                ⚠️ Capitaine enregistré : <strong>{t.captainName ?? "inconnu"}</strong>,
                                qui ne fait plus partie de cette équipe. Il reçoit toujours ses
                                récapitulatifs — choisis-en un autre, ou « — aucun — ».
                              </p>
                            )}
                            {/* Le capitaine doit JOUER dans l'équipe : le serveur refuse un
                                membre extérieur. Quand la liste est vide, on le DIT plutôt que
                                de laisser un sélecteur inerte dont on cherche la panne. */}
                            {siens.length === 0 && (
                              <p className="muted tiny">
                                Rattache d&apos;abord des membres à cette équipe depuis la{" "}
                                <Link href="/admin/membres">page Membres</Link>.
                              </p>
                            )}

                            <details className="ic-sn">
                              <summary>
                                Calendrier fédéral
                                <span className="muted tiny">
                                  {t.snEventId
                                    ? t.snCheckedAt
                                      ? ` · contrôlé le ${new Date(t.snCheckedAt).toLocaleDateString("fr-FR")}`
                                      : " · jamais importé"
                                    : " · non rattaché"}
                                </span>
                              </summary>

                              <p className="muted tiny">
                                Quatre identifiants, et ils vont <strong>ensemble</strong>.{" "}
                                <strong>eventid</strong> et <strong>teamid</strong> se lisent dans
                                l&apos;URL de la page « équipes » de l&apos;équipe sur squashnet
                                (<code>?eventid=…&amp;teamid=…</code>). La{" "}
                                <strong>poule</strong> se lit sur cette même page, dans le code
                                du tableau de la poule (<code>round_370138</code> ⇒ saisir{" "}
                                <code>370138</code>). La <strong>division</strong> se lit dans la
                                liste « Tableau/Division » de la page « Classement et rencontres »
                                (<code>Hommes 4</code> ⇒ <code>47760</code>).
                              </p>
                              {/* La division ne sert PAS au calendrier — elle sert au
                                  classement, et son absence y est encore plus traître que celle
                                  de la poule : sans elle, `roundid` est ignoré et la fédération
                                  rend la division 1. Huit équipes, dix-huit colonnes, un
                                  tableau parfaitement crédible, et pas une ligne qui nous
                                  concerne. On l'afficherait tel quel. */}
                              <p className="muted tiny">
                                Sans la division, le <strong>classement</strong> affiché serait
                                celui de la division 1 — un tableau juste en apparence, où
                                l&apos;équipe ne figure pas.
                              </p>
                              {/* La poule N'EST PAS un raffinement : une épreuve en contient
                                  plusieurs, et sans elle squashnet rend celle qu'il veut. Sur
                                  notre propre critérium, c'était une poule où l'Yvette ne figure
                                  pas — donc un import de zéro rencontre, muet. Le dire ici, c'est
                                  éviter que quelqu'un laisse le champ vide en le croyant
                                  facultatif. */}
                              <p className="muted tiny">
                                Sans la poule, l&apos;import rapporte <strong>zéro rencontre</strong>{" "}
                                sans rien dire : une épreuve en contient plusieurs, et la
                                fédération en rend une au hasard.
                              </p>

                              <div className="ic-sn-fields">
                                <input
                                  value={anchorFields(t).eventId}
                                  disabled={icBusy}
                                  onChange={(ev) => editAnchor(t, { eventId: ev.target.value })}
                                  placeholder="eventid"
                                  aria-label={`Identifiant d'épreuve squashnet de ${t.name}`}
                                />
                                <input
                                  value={anchorFields(t).drawId}
                                  disabled={icBusy}
                                  onChange={(ev) => editAnchor(t, { drawId: ev.target.value })}
                                  placeholder="division"
                                  inputMode="numeric"
                                  aria-label={`Identifiant de division squashnet de ${t.name}`}
                                />
                                <input
                                  value={anchorFields(t).roundId}
                                  disabled={icBusy}
                                  onChange={(ev) => editAnchor(t, { roundId: ev.target.value })}
                                  placeholder="poule"
                                  inputMode="numeric"
                                  aria-label={`Identifiant de poule squashnet de ${t.name}`}
                                />
                                <input
                                  value={anchorFields(t).snTeamId}
                                  disabled={icBusy}
                                  onChange={(ev) => editAnchor(t, { snTeamId: ev.target.value })}
                                  placeholder="teamid"
                                  inputMode="numeric"
                                  aria-label={`Identifiant d'équipe squashnet de ${t.name}`}
                                />
                                <button type="button" disabled={icBusy} onClick={() => saveAnchor(t)}>
                                  Enregistrer
                                </button>
                              </div>

                              {/* Le classement se relit à la demande : le cron hebdomadaire ne
                                  passe que le lundi, et c'est JUSTE APRÈS avoir saisi l'ancrage
                                  qu'on a besoin de vérifier qu'il est bon. */}
                              <button
                                type="button"
                                className="secondary ic-sn-standings"
                                disabled={
                                  icCalBusy !== null ||
                                  !t.snEventId ||
                                  !t.snTeamId ||
                                  !t.snRoundId ||
                                  !t.snDrawId
                                }
                                onClick={() => refreshStandings(t)}
                                // Le bouton est grisé si L'UN DES QUATRE identifiants manque ;
                                // l'infobulle n'en testait qu'un et promettait « retélécharge
                                // maintenant » sur un bouton mort, sans dire ce qui manquait.
                                title={
                                  ancrageManquant(t) ??
                                  "Retélécharge le classement de la poule maintenant."
                                }
                              >
                                {icCalBusy === t.id ? "Lecture…" : "Relire le classement"}
                                {t.snStandingsAt && (
                                  <span className="muted tiny">
                                    {" "}
                                    (relevé du{" "}
                                    {new Date(t.snStandingsAt).toLocaleDateString("fr-FR", {
                                      day: "numeric",
                                      month: "short",
                                    })}
                                    )
                                  </span>
                                )}
                              </button>

                              <button
                                type="button"
                                className="secondary"
                                disabled={
                                  icCalBusy !== null || !t.snEventId || !t.snTeamId || !t.snRoundId
                                }
                                onClick={() => previewCalendar(t)}
                                title={
                                  // Le calendrier n'exige que TROIS identifiants : la division
                                  // ne sert qu'au classement, et l'exiger ici priverait
                                  // d'import les équipes ancrées avant qu'elle existe.
                                  t.snEventId && t.snRoundId && t.snTeamId
                                    ? "Télécharge le calendrier publié et montre l'écart, sans rien écrire."
                                    : "Renseigne d'abord l'épreuve, la poule et l'équipe."
                                }
                              >
                                {icCalBusy === t.id ? "…" : "Prévisualiser l'import"}
                              </button>

                              {/* L'APERÇU. Il montre ce qui serait écrit, en français et champ
                                  par champ — un scraping qui casse ne doit pas pouvoir vider un
                                  calendrier ni déplacer une convocation tout seul. */}
                              {icCal?.teamId === t.id && (
                                <div className="ic-cal-preview">
                                  <p className="ic-cal-sum">
                                    <strong>{icCal.published}</strong> rencontre
                                    {icCal.published > 1 ? "s" : ""} publiée
                                    {icCal.published > 1 ? "s" : ""} pour nous ·{" "}
                                    {icCal.toCreate.length} à créer · {icCal.toUpdate.length} à
                                    corriger · {icCal.unchanged} inchangée
                                    {icCal.unchanged > 1 ? "s" : ""}
                                  </p>

                                  {icCal.toCreate.length === 0 &&
                                  icCal.toUpdate.length === 0 &&
                                  icCal.toDelete.length === 0 &&
                                  icCal.confirmDrift.length === 0 ? (
                                    <p className="muted tiny">
                                      Rien à changer : la base est à jour.
                                    </p>
                                  ) : (
                                    <ul className="ic-cal-list">
                                      {icCal.toCreate.map((c) => (
                                        <li key={`c${c.round}`}>
                                          <strong>{c.round}</strong> à créer — {c.date}
                                          {c.time && ` à ${c.time}`} ·{" "}
                                          {c.home ? "à domicile" : "à l'extérieur"} contre{" "}
                                          {c.opponent}
                                          {!c.dateConfirmed && (
                                            <span className="ic-provisoire-tag">prévisionnelle</span>
                                          )}
                                        </li>
                                      ))}
                                      {icCal.toUpdate.map((u) => (
                                        <li key={u.id}>
                                          <strong>{u.tie.round}</strong> —{" "}
                                          {u.changes
                                            .map(
                                              (c) =>
                                                `${CAL_FIELDS[c.field] ?? c.field} : ${calValue(c.field, c.from)} → ${calValue(c.field, c.to)}`,
                                            )
                                            .join(" · ")}
                                          {/* Ce que l'import NE fera PAS : une rencontre déjà
                                              commencée garde sa date, comme la correction à la
                                              main le refuse déjà. Le taire ferait croire à un
                                              report appliqué. */}
                                          {icCal.frozen.includes(u.tie.round) && (
                                            <em className="muted">
                                              {" "}
                                              — date gardée (rencontre commencée)
                                            </em>
                                          )}
                                        </li>
                                      ))}
                                      {/* LE STATUT DE LA DATE, qui se signale sans s'appliquer.
                                          C'est une déduction (plusieurs journées le même jour =
                                          date bouchon), et elle a deux angles morts connus : un
                                          rattrapage à deux journées le même soir passe pour
                                          prévisionnel, une journée non planifiée seule passe
                                          pour ferme. L'admin est celui qui tranche — réécrire
                                          par-dessus lui révoquerait sa correction en silence. */}
                                      {icCal.confirmDrift.map((c) => (
                                        <li key={`s${c.id}`}>
                                          <strong>{c.round}</strong> — la ligue la publie{" "}
                                          {c.published ? "confirmée" : "prévisionnelle"}, la base la
                                          dit {c.stored ? "confirmée" : "prévisionnelle"}.{" "}
                                          <em className="muted">
                                            Non appliqué : à corriger sur la rencontre si besoin.
                                          </em>
                                        </li>
                                      ))}
                                      {/* Une journée RETIRÉE du calendrier fédéral. On la montre
                                          sans jamais la supprimer : elle porte peut-être déjà une
                                          composition et des réponses, et « plus rien n'est
                                          publié » peut n'être qu'un scraping qui a cassé. */}
                                      {icCal.toDelete.map((d) => (
                                        <li key={d.id}>
                                          <strong>{d.round ?? "?"}</strong> n&apos;est plus publiée
                                          ({d.date} c. {d.opponent}) — à vérifier, puis à supprimer
                                          à la main si c&apos;est confirmé.
                                        </li>
                                      ))}
                                    </ul>
                                  )}

                                  {/* Ce que l'application COÛTE, dit avant de cliquer : une
                                      date qui bouge efface des réponses déjà données. Le
                                      découvrir après serait le découvrir trop tard. */}
                                  {icCal.toUpdate.some((u) => u.changes.some((c) => c.field === "date")) && (
                                    <p className="ic-cal-warn">
                                      ⚠️ Une date qui change efface les disponibilités déjà
                                      recueillies pour cette rencontre, et l&apos;équipe est
                                      prévenue du report.
                                    </p>
                                  )}

                                  <div className="ic-cal-actions">
                                    <button
                                      type="button"
                                      disabled={
                                        icCalBusy !== null ||
                                        (icCal.toCreate.length === 0 &&
                                          icCal.toUpdate.length === 0 &&
                                          icCal.confirmDrift.length === 0)
                                      }
                                      title={
                                        icCal.toCreate.length === 0 &&
                                        icCal.toUpdate.length === 0 &&
                                        icCal.confirmDrift.length === 0
                                          ? "Rien à appliquer : la base est déjà à jour."
                                          : icCal.toCreate.length === 0 && icCal.toUpdate.length === 0
                                            ? "Rien à écrire — enregistre seulement que ce calendrier a été vu, pour que le contrôle hebdomadaire cesse de le signaler."
                                            : "Écrit les créations et corrections listées ci-dessus."
                                      }
                                      onClick={() => applyCalendar(t)}
                                    >
                                      {icCalBusy === t.id ? "Import…" : "Appliquer"}
                                    </button>
                                    <button
                                      type="button"
                                      className="secondary"
                                      disabled={icCalBusy !== null}
                                      onClick={() => setIcCal(null)}
                                    >
                                      Fermer
                                    </button>
                                  </div>
                                </div>
                              )}
                            </details>
                          </div>
                        </div>
                      );
                    })}

                    <div className="ic-add">
                      <span className="ic-add-title">Ajouter un joueur sans compte</span>
                      <select
                        value={icTeamId}
                        onChange={(e) => setIcTeamId(e.target.value)}
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
                      />
                      {/* Plus de classement à saisir ici : il est CHERCHÉ sur squashnet à
                          l'ajout, et la réponse le dit tout de suite. Le demander d'avance
                          revenait à faire recopier à la main une donnée publique — et à la
                          figer, puisqu'une saisie manuelle a priorité sur le rapprochement. */}
                      <button
                        type="button"
                        disabled={icBusy || !icTeamId || !icName.trim()}
                        onClick={addGuest}
                        title="Le classement est cherché sur squashnet à partir du nom."
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
              <section className="adm-carte">
                <h3 className="adm-carte-titre">Classement squashnet</h3>
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
          </Groupe>
        </>
      )}
    </main>
  );
}

// Vignette d'indicateur du tableau de bord.
// Elle S'ENFONCE au lieu de s'encadrer : une liste posée sur une carte ne se sépare pas en
// donnant une carte à chaque élément (Règle de la Carte sur Carte). Deux surfaces de même
// valeur ne se distinguent pas l'une de l'autre, si bien ombrées soient-elles.
function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="adm-stat">
      <div className="adm-stat-valeur">{value}</div>
      <div className="tiny">{label}</div>
      {hint && <div className="muted tiny">{hint}</div>}
    </div>
  );
}
