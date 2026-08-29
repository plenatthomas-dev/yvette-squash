"use client";

// Panneau ⚙️ Paramètres (extrait de page.tsx) : thème, pseudonyme, annuaire,
// délégation de droits, commentaire. Les utilitaires de thème et les icônes
// ci-dessous ne servent qu'ici.

import { useEffect, useState, type ReactNode } from "react";
import { Dialog } from "@/components/Dialog";
import { useFeatures } from "@/components/FeatureProvider";
import { DELEGATION_DURATIONS } from "@/lib/delegation-shared";
import {
  fetchDirectory,
  invalidateDirectory,
  type DirectoryMember,
} from "@/lib/directoryCache";
import {
  ensurePushSubscribed,
  pushEnabledOnServer,
  pushSubscriptionState,
  pushSupported,
  unsubscribePush,
} from "@/lib/pushClient";
import {
  enrollPasskey,
  passkeySupported,
  forgetPasskeyOnDevice,
  hasPasskeyOnDevice,
} from "@/lib/webauthnClient";
import { isSoundEnabled, setSoundEnabled, playSuccessJingle } from "@/lib/sound";
// Le même normaliseur que le rapprochement des classements : sans accents ni casse, « zoe »
// doit trouver « Zoé » et « jean luc » trouver « Jean-Luc ». Module pur (son unique import est
// un `import type`, effacé à la compilation) : rien de serveur n'entre dans le bundle client.
import { normalize } from "@/lib/squashnet/match";

type PasskeyInfo = {
  id: string;
  deviceLabel: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  backedUp: boolean | null; // true = synchronisé (iCloud/Google) ; false = lié à l'appareil ; null = inconnu
  deviceType: string | null; // "singleDevice" | "multiDevice"
};

// Thèmes disponibles. "rose" = variante « pinky » (voir globals.css). Persisté en localStorage.
type Theme = "system" | "light" | "dark" | "rose";
const THEMES: { key: Theme; label: string }[] = [
  { key: "system", label: "Système" },
  { key: "light", label: "Clair" },
  { key: "dark", label: "Sombre" },
  { key: "rose", label: "Short Rose" },
];
function isTheme(v: unknown): v is Theme {
  return v === "system" || v === "light" || v === "dark" || v === "rose";
}
function applyTheme(t: Theme) {
  const el = document.documentElement;
  if (t === "system") el.removeAttribute("data-theme"); // Pico suit prefers-color-scheme
  else el.setAttribute("data-theme", t);
}
// Icône par thème : soleil (clair), lune (sombre), écran (système), short (rose).
function ThemeIcon({ theme }: { theme: Theme }) {
  const p = {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (theme === "light") {
    return (
      <svg {...p}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }
  if (theme === "dark") {
    return (
      <svg {...p}>
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
    );
  }
  if (theme === "rose") {
    // Short (bermuda) : ceinture + deux jambes avec échancrure centrale.
    return (
      <svg {...p}>
        <path d="M5 5H19L18 19H13L12 11L11 19H6Z" />
        <path d="M5 8H19" />
      </svg>
    );
  }
  // Système : écran + pied.
  return (
    <svg {...p}>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}
// Icône « roue crantée » (paramètres)
function GearIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

// Icône « RAZ » (flèche de réinitialisation) — efface le pseudonyme.
function ResetIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  );
}

// En-tête d'une section de Paramètres : titre + petit bouton « i » qui déplie/replie
// l'explication (les phrases longues n'occupent plus la modale en permanence).
// Le repère « i », DESSINÉ et non composé.
//
// Sa rondeur était jusqu'ici une propriété de sa boîte : un <button> carré arrondi à 50 %.
// Toute la difficulté venait de là — il suffisait qu'une règle tierce (Pico habille tous les
// <button>) touche la hauteur, le remplissage ou l'interligne pour que le carré devienne un
// rectangle, et le cercle une ellipse. Quatre tailles et deux formes plus tard, c'était encore
// le cas.
//
// En SVG, la rondeur n'est plus une affaire de boîte mais de géométrie : le cercle reste un
// cercle quoi qu'il arrive à l'élément qui le porte. Le dessin fait 1em, et le `em` du bouton
// est la taille du titre voisin — le repère est donc exactement à sa hauteur, par construction.
function InfoTipIcon() {
  return (
    <svg className="info-tip-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle className="info-tip-disc" cx="12" cy="12" r="10" />
      <line className="info-tip-stem" x1="12" y1="11" x2="12" y2="17" />
      <line className="info-tip-stem" x1="12" y1="7.2" x2="12" y2="7.2" />
    </svg>
  );
}

function SettingInfo({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="setting-head">
        <h4>{title}</h4>
        <button
          type="button"
          className="info-tip-btn"
          aria-expanded={open}
          aria-label={`${open ? "Masquer" : "Afficher"} l'explication : ${title}`}
          title="Qu'est-ce que c'est ?"
          onClick={() => setOpen((o) => !o)}
        >
          <InfoTipIcon />
        </button>
      </div>
      {open && <p className="muted tiny setting-info-text">{children}</p>}
    </>
  );
}

// Panneau de paramètres : choix du thème (dont « Short Rose ») + choix du pseudonyme.
export function SettingsButton({
  myId,
  nickname,
  listed,
  onProfileSaved,
  onDelegationsChanged,
  toast,
}: {
  myId: string | null;
  nickname: string | null;
  listed: boolean;
  onProfileSaved: () => void;
  /** Une délégation REÇUE a changé : l'appelant doit relire les siennes (sélecteur « Pour X »). */
  onDelegationsChanged: () => void;
  toast: (type: "ok" | "err" | "info", msg: string) => void;
}) {
  const { directory, delegation, biometry } = useFeatures();
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>("system");
  const [nick, setNick] = useState(nickname ?? "");
  const [saving, setSaving] = useState(false);
  // État optimiste de la case « annuaire » : bascule tout de suite, se resync sur `listed`.
  const [listedLocal, setListedLocal] = useState(listed);
  const [savingListed, setSavingListed] = useState(false);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  // Son de confirmation de réservation (activé par défaut). Lu depuis localStorage à l'ouverture.
  const [soundOn, setSoundOn] = useState(true);
  // Notifications de cet APPAREIL. L'abonnement est propre au navigateur (et à l'origine :
  // celui de la recette ne vaut pas pour la production), d'où un état lu à l'ouverture plutôt
  // qu'un simple interrupteur qui mentirait d'un téléphone à l'autre.
  const [pushState, setPushState] = useState<{
    permission: NotificationPermission | "unsupported";
    subscribed: boolean;
  } | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  // Doit rester synchronisé avec MAX_LEN côté serveur (api/feedback/route.ts).
  const COMMENT_MAX = 1000;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    pushSubscriptionState().then((st) => {
      if (!cancelled) setPushState(st);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Délégation (idée 4) : liste des membres (pour choisir des délégués) + délégations
  // sortantes actives (une par délégué). Chargées à l'ouverture du panneau (peuvent avoir bougé).
  const [delegateMembers, setDelegateMembers] = useState<
    { id: string; name: string }[] | null
  >(null);
  const [outgoingDelegations, setOutgoingDelegations] = useState<
    { id: string; delegateId: string; delegateName: string; expiresAt: string }[]
  >([]);
  // Délégations REÇUES : celles qu'on m'a accordées. Listées pour pouvoir les rendre — on ne
  // les demande pas, on ne devrait pas être obligé de les garder.
  const [incomingDelegations, setIncomingDelegations] = useState<
    { id: string; delegatorId: string; delegatorName: string; expiresAt: string }[]
  >([]);
  const [pickedDelegates, setPickedDelegates] = useState<string[]>([]);
  const [pickedHours, setPickedHours] = useState<number>(DELEGATION_DURATIONS[0].hours);
  // Liste des délégués POSSIBLES : repliée par défaut. Elle grandit avec le club, et déroulée
  // en permanence elle repoussait tout le reste des réglages sous la ligne de flottaison —
  // alors qu'on ne délègue ses droits que quelques fois par saison. Ce qui compte au quotidien
  // (à QUI j'ai délégué), lui, reste visible sans rien ouvrir.
  const [pickerOpen, setPickerOpen] = useState(false);
  // Filtre de cette liste. C'est le corollaire du repli : une liste qu'on n'ouvre qu'à la
  // demande doit se parcourir vite une fois ouverte, et l'annuaire d'un club dépasse
  // largement la hauteur du panneau.
  const [delegateQuery, setDelegateQuery] = useState("");
  // Opération délégation en cours : "create" (formulaire) ou l'id de la ligne concernée
  // (prolongation/révocation). Un seul appel à la fois, mais le « … » ne s'affiche que
  // sur le bouton réellement actif (les autres sont juste désactivés).
  const [busy, setBusy] = useState<string | null>(null);
  // Délégué dont on est en train de choisir la durée de prolongation (boutons inline).
  const [extending, setExtending] = useState<string | null>(null);
  // Échéance de MA session ResaMania : plafond de fonctionnement des délégations
  // (30 j non glissants après connexion — cf. docs/delegation-droits.md). Intégrée à la
  // bulle « i » du titre de section (toujours accessible, même sans formulaire).
  const [sessionExpiresAt, setSessionExpiresAt] = useState<string | null>(null);

  // Connexion biométrique (passkeys) — tout compte connecté. Pour un compte ResaMania, la
  // connexion par passkey restaure sa session ResaMania via le refresh token (option A).
  const showPasskeys = biometry;
  const [pkSupported, setPkSupported] = useState(false);
  const [passkeys, setPasskeys] = useState<PasskeyInfo[] | null>(null);
  const [pkBusy, setPkBusy] = useState(false);
  // « Cet appareil a-t-il déjà un passkey ? » (marqueur local par appareil). Sert à n'afficher
  // « Activer sur cet appareil » QUE là où ça a du sens : sur un appareil déjà enrôlé, le seul
  // bouton pertinent est le « Retirer » de sa ligne (un seul bouton activer/retirer, selon le
  // contexte). On exige aussi un passkey côté serveur, au cas où le marqueur local serait resté
  // alors que le passkey a été supprimé depuis un autre appareil.
  const [pkOnDevice, setPkOnDevice] = useState(false);
  const enabledOnThisDevice = pkOnDevice && (passkeys?.length ?? 0) > 0;
  // Avertissement « risque de blocage » : le membre a au moins un passkey LIÉ à l'appareil
  // (backedUp=false) et AUCUN synchronisé (backedUp=true) → perdre l'appareil = perdre l'accès
  // biométrique. Les passkeys d'avant la migration (backedUp=null) sont ignorés (état inconnu).
  const anyBackedUp = (passkeys ?? []).some((p) => p.backedUp === true);
  const anyDeviceBound = (passkeys ?? []).some((p) => p.backedUp === false);
  const showLockoutWarning = anyDeviceBound && !anyBackedUp;

  const loadPasskeys = async () => {
    try {
      const res = await fetch("/api/auth/webauthn/passkeys");
      const data = await res.json().catch(() => ({}));
      setPasskeys(res.ok ? (data.passkeys ?? []) : []);
    } catch {
      setPasskeys([]);
    }
  };

  useEffect(() => {
    if (!open || !showPasskeys) return;
    passkeySupported().then(setPkSupported);
    setPkOnDevice(hasPasskeyOnDevice());
    loadPasskeys();
  }, [open, showPasskeys]);

  const addPasskey = async () => {
    setPkBusy(true);
    // Libellé pour reconnaître l'appareil dans la liste (ex. « iPhone de Tom »).
    const label =
      typeof window !== "undefined"
        ? window.prompt("Nom de cet appareil (facultatif) :", "")?.trim() || undefined
        : undefined;
    const r = await enrollPasskey(label);
    setPkBusy(false);
    if (r.ok) {
      setPkOnDevice(true); // cet appareil est désormais enrôlé (enrollPasskey a posé le marqueur)
      toast("ok", "Connexion biométrique activée sur cet appareil.");
      loadPasskeys();
    } else {
      toast("err", r.error ?? "Activation impossible.");
    }
  };

  // Renomme un appareil (ex. « iPhone de Tom ») : prompt simple → PATCH borné à mes passkeys.
  const renamePasskey = async (id: string, current: string | null) => {
    if (typeof window === "undefined") return;
    const input = window.prompt("Nom de cet appareil :", current ?? "");
    if (input === null) return; // annulé
    setPkBusy(true);
    try {
      const res = await fetch(`/api/auth/webauthn/passkeys/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceLabel: input.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);
      setPasskeys((prev) =>
        (prev ?? []).map((p) => (p.id === id ? { ...p, deviceLabel: data.deviceLabel ?? null } : p)),
      );
      toast("ok", "Appareil renommé.");
    } catch (e) {
      toast("err", (e as Error).message);
    } finally {
      setPkBusy(false);
    }
  };

  const removePasskey = async (id: string) => {
    setPkBusy(true);
    try {
      const res = await fetch(`/api/auth/webauthn/passkeys/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Erreur ${res.status}`);
      setPasskeys((prev) => {
        const next = (prev ?? []).filter((p) => p.id !== id);
        // Plus aucun passkey côté serveur : oublie l'indicateur local pour ne pas tenter une
        // auto-connexion biométrique vouée à l'échec au prochain lancement (et re-proposer
        // « Activer sur cet appareil »).
        if (next.length === 0) {
          forgetPasskeyOnDevice();
          setPkOnDevice(false);
        }
        return next;
      });
      toast("ok", "Passkey supprimé.");
    } catch (e) {
      toast("err", (e as Error).message);
    } finally {
      setPkBusy(false);
    }
  };

  useEffect(() => {
    if (!open || !delegation) return;
    let cancelled = false;
    setExtending(null); // réouverture du panneau : pas de choix de durée résiduel
    setPickerOpen(false); // …ni sélection de délégués restée ouverte
    setPickedDelegates([]);
    setDelegateQuery("");
    (async () => {
      try {
        // Annuaire via le cache mémoire partagé (dédupliqué avec la modale Annuaire) ;
        // délégations sortantes en parallèle (spécifique, non caché).
        const [members, delRes] = await Promise.all([
          fetchDirectory().catch(() => [] as DirectoryMember[]),
          fetch("/api/delegations"),
        ]);
        const del = await delRes.json().catch(() => ({}));
        if (cancelled) return;
        setDelegateMembers(members);
        setOutgoingDelegations(delRes.ok ? (del.outgoing ?? []) : []);
        setIncomingDelegations(delRes.ok ? (del.incoming ?? []) : []);
        setSessionExpiresAt(delRes.ok ? (del.sessionExpiresAt ?? null) : null);
      } catch {
        if (!cancelled) {
          setDelegateMembers([]);
          setOutgoingDelegations([]);
          setIncomingDelegations([]);
          setSessionExpiresAt(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, delegation]);

  // Membres à qui je ne délègue pas encore : seuls eux sont proposés dans la liste à
  // cocher (renouveler/étendre une délégation en cours = révoquer puis redonner).
  // Moi-même exclu : l'annuaire me liste, mais se déléguer ses propres droits n'a
  // pas de sens (le serveur le refuse déjà, autant ne pas le proposer).
  const availableDelegates = (delegateMembers ?? []).filter(
    (m) => m.id !== myId && !outgoingDelegations.some((d) => d.delegateId === m.id),
  );

  // Le filtre ne masque QUE l'affichage : une case cochée puis filtrée hors de vue reste
  // sélectionnée, et le compteur du bouton « Déléguer (n) » continue de la compter — sans quoi
  // taper une recherche annulerait en silence une partie du choix déjà fait.
  const q = normalize(delegateQuery);
  const shownDelegates = q
    ? availableDelegates.filter((m) => normalize(m.name).includes(q))
    : availableDelegates;

  const toggleDelegate = (id: string, on: boolean) =>
    setPickedDelegates((prev) => (on ? [...prev, id] : prev.filter((x) => x !== id)));

  // Replier ANNULE la sélection en cours : rouvrir sur des cases encore cochées laisserait
  // croire qu'une délégation a été accordée alors que « Déléguer » n'a jamais été touché.
  const closePicker = () => {
    setPickerOpen(false);
    setPickedDelegates([]);
    setDelegateQuery("");
  };

  // POST partagé création / prolongation : le serveur renouvelle (révoque + recrée) toute
  // délégation active vers les mêmes délégués — prolonger = re-poster le même membre avec
  // la durée choisie. Renvoie true en cas de succès (pour vider la sélection, etc.).
  const postDelegations = async (
    ids: string[],
    opts: { okMsg: string; busyKey: string; hours?: number; extend?: boolean },
  ): Promise<boolean> => {
    const { okMsg, busyKey, hours = pickedHours, extend = false } = opts;
    setBusy(busyKey);
    try {
      const res = await fetch("/api/delegations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delegateIds: ids, hours, extend }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);
      const nameById = new Map((delegateMembers ?? []).map((m) => [m.id, m.name]));
      const created = (data.delegations ?? []) as {
        id: string;
        delegateId: string;
        expiresAt?: string;
      }[];
      setOutgoingDelegations((prev) => [
        ...created.map((d) => ({
          id: d.id,
          delegateId: d.delegateId,
          // Nom : annuaire, sinon l'ancienne entrée (délégué sorti de l'annuaire entre-temps).
          delegateName:
            nameById.get(d.delegateId) ??
            prev.find((p) => p.delegateId === d.delegateId)?.delegateName ??
            "ce membre",
          // Échéance par entrée : une prolongation part de l'échéance actuelle du délégué.
          expiresAt: d.expiresAt ?? data.expiresAt,
        })),
        // Un délégué recréé côté serveur (renouvellement) remplace son ancienne entrée.
        ...prev.filter((p) => !created.some((c) => c.delegateId === p.delegateId)),
      ]);
      toast("ok", okMsg);
      return true;
    } catch (e) {
      toast("err", (e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const createDelegations = async () => {
    if (pickedDelegates.length === 0) return;
    const ok = await postDelegations(pickedDelegates, {
      okMsg: pickedDelegates.length > 1 ? "Délégations activées" : "Délégation activée",
      busyKey: "create",
    });
    if (ok) closePicker();
  };

  // `rowId` = id de la délégation (la ligne affichée) ; le POST vise le délégué.
  const extendDelegation = async (rowId: string, delegateId: string, hours: number) => {
    const ok = await postDelegations([delegateId], {
      okMsg: "Délégation prolongée",
      busyKey: rowId,
      hours,
      extend: true,
    });
    if (ok) setExtending(null);
  };

  const revokeDelegation = async (id: string) => {
    setBusy(id);
    try {
      const res = await fetch(`/api/delegations/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`Erreur ${res.status}`);
      setOutgoingDelegations((prev) => prev.filter((d) => d.id !== id));
      toast("ok", "Délégation révoquée");
    } catch (e) {
      toast("err", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  /**
   * Rendre une délégation REÇUE. Même route que la révocation (les deux parties peuvent mettre
   * fin à une délégation) : personne ne devrait subir le pouvoir d'agir au nom d'un autre sans
   * l'avoir demandé. On prévient l'appelant : le sélecteur « Pour X » de l'en-tête doit
   * disparaître aussitôt, sinon on garderait un choix qui n'a plus de droits derrière — et
   * s'en servir renverrait une erreur.
   */
  const releaseDelegation = async (id: string) => {
    setBusy(id);
    try {
      const res = await fetch(`/api/delegations/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Erreur ${res.status}`);
      setIncomingDelegations((prev) => prev.filter((d) => d.id !== id));
      toast("ok", "Délégation rendue");
      onDelegationsChanged();
    } catch (e) {
      toast("err", (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    const saved = localStorage.getItem("theme");
    const t: Theme = isTheme(saved) ? saved : "system";
    setTheme(t);
    applyTheme(t);
    // Reflète la préférence de son (localStorage) dans l'interrupteur, côté client uniquement.
    setSoundOn(isSoundEnabled());
  }, []);

  const toggleSound = (on: boolean) => {
    setSoundOn(on);
    setSoundEnabled(on);
    if (on) playSuccessJingle(); // aperçu immédiat quand on (ré)active
  };

  // Resynchronise le champ quand le pseudo change côté serveur / à l'ouverture.
  useEffect(() => {
    if (open) setNick(nickname ?? "");
  }, [open, nickname]);

  // Idem pour la case annuaire.
  useEffect(() => {
    setListedLocal(listed);
  }, [listed]);

  const pickTheme = (t: Theme) => {
    setTheme(t);
    localStorage.setItem("theme", t);
    applyTheme(t);
  };

  // Enregistre un pseudo (ou null pour l'effacer). `close` ferme le panneau après succès.
  const persist = async (value: string | null, close: boolean) => {
    setSaving(true);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);
      // Le nom affiché dans l'annuaire vient de changer : purge le cache client pour
      // qu'une ouverture immédiate de l'annuaire (< TTL) montre le nouveau pseudo.
      invalidateDirectory();
      toast("ok", value ? "Pseudonyme enregistré" : "Pseudonyme retiré");
      onProfileSaved();
      if (close) setOpen(false);
    } catch (e) {
      toast("err", (e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const saveNick = () => persist(nick.trim() ? nick : null, true);

  // Bascule la visibilité dans l'annuaire (opt-out). Optimiste : on met à jour la case tout
  // de suite, puis on PATCH ; en cas d'échec on revient en arrière.
  const toggleListed = async (next: boolean) => {
    setListedLocal(next);
    setSavingListed(true);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listed: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);
      // La composition de l'annuaire vient de changer : même purge que pour le pseudo.
      invalidateDirectory();
      toast("ok", next ? "Tu apparais dans l'annuaire" : "Tu es retiré de l'annuaire");
      onProfileSaved();
    } catch (e) {
      setListedLocal(!next); // rollback
      toast("err", (e as Error).message);
    } finally {
      setSavingListed(false);
    }
  };
  const clearNick = () => {
    setNick("");
    persist(null, false); // RAZ : efface le pseudo, panneau ouvert pour resaisir
  };

  const sendComment = async () => {
    if (!comment.trim()) return;
    setSending(true);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: comment }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);
      toast("ok", "Merci ! Ton message a été envoyé.");
      setComment("");
    } catch (e) {
      toast("err", (e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <button
        className="secondary icon-btn"
        onClick={() => setOpen(true)}
        aria-label="Paramètres"
        title="Paramètres"
      >
        <GearIcon />
      </button>
      {open && (
        <Dialog onClose={() => setOpen(false)} label="Paramètres" className="settings">
            {/* En-tête COLLANT avec sa propre croix. Le seul bouton « Fermer » était tout en
                bas : sur un panneau riche (thème, pseudo, annuaire, délégation, biométrie,
                son, commentaire), il fallait faire défiler l'intégralité de la fenêtre pour
                pouvoir la refermer. La croix reste à portée quel que soit le défilement. */}
            <div className="settings-head">
              <h3>Paramètres</h3>
              <button
                type="button"
                className="secondary settings-close"
                onClick={() => setOpen(false)}
                aria-label="Fermer les paramètres"
                title="Fermer"
              >
                ✕
              </button>
            </div>

            <section className="setting">
              <h4>Thème</h4>
              <div className="theme-choices" role="group" aria-label="Thème">
                {THEMES.map((t) => (
                  <button
                    key={t.key}
                    className={
                      "theme-chip" +
                      (t.key === "rose" ? " theme-chip--rose" : "") +
                      (theme === t.key ? " active" : "")
                    }
                    aria-pressed={theme === t.key}
                    aria-label={t.label}
                    title={t.label}
                    onClick={() => pickTheme(t.key)}
                  >
                    <ThemeIcon theme={t.key} />
                  </button>
                ))}
              </div>
            </section>

            <section className="setting">
              <h4>Pseudonyme</h4>
              <p className="muted tiny">
                Affiché à la place de ton prénom. Laisse vide pour revenir au prénom.
              </p>
              <div className="nick-field">
                <input
                  type="text"
                  aria-label="Pseudonyme"
                  value={nick}
                  maxLength={24}
                  placeholder="Ton pseudo"
                  onChange={(e) => setNick(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveNick();
                  }}
                />
                <button onClick={saveNick} disabled={saving}>
                  {saving ? "…" : "Enregistrer"}
                </button>
                {(nickname || nick.trim()) && (
                  <button
                    className="secondary icon-btn"
                    onClick={clearNick}
                    disabled={saving}
                    aria-label="Effacer le pseudonyme"
                    title="Effacer le pseudonyme"
                  >
                    <ResetIcon />
                  </button>
                )}
              </div>
            </section>

            {directory && (
              <section className="setting">
                <SettingInfo title="Annuaire des membres">
                  Par défaut, ton nom (ou pseudo) apparaît dans l'annuaire des membres pour
                  faciliter l'entraide entre joueurs. Tu peux t'en retirer à tout moment.
                </SettingInfo>
                <label className="check-row">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={listedLocal}
                    disabled={savingListed}
                    onChange={(e) => toggleListed(e.target.checked)}
                  />
                  <span>Apparaître dans l'annuaire</span>
                </label>
              </section>
            )}

            {delegation && (
              <section className="setting">
                <SettingInfo title="Déléguer mes droits">
                  Autorise un ou plusieurs membres à réserver/annuler en ton nom pendant une
                  durée limitée. La réservation reste sous ton compte ResaMania.
                  {sessionExpiresAt && (
                    <>
                      {" "}
                      ⏳ Ta connexion ResaMania est valable jusqu'au{" "}
                      {new Date(sessionExpiresAt).toLocaleString("fr-FR", {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}{" "}
                      : une délégation ne peut pas fonctionner au-delà (reconnecte-toi pour
                      repartir sur 30 jours).
                    </>
                  )}
                </SettingInfo>
                {/* Délégations REÇUES : on peut les rendre (on ne les a pas demandées). */}
                {incomingDelegations.length > 0 && (
                  <ul className="delegation-active-list">
                    {incomingDelegations.map((d) => (
                      <li key={d.id} className="delegation-active">
                        <p className="tiny">
                          <strong>{d.delegatorName}</strong> t'a délégué ses droits jusqu'au{" "}
                          {new Date(d.expiresAt).toLocaleString("fr-FR", {
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                          .
                        </p>
                        <div className="delegation-row-actions">
                          <button
                            className="secondary"
                            onClick={() => releaseDelegation(d.id)}
                            disabled={busy !== null}
                            title={`Tu ne pourras plus réserver au nom de ${d.delegatorName}`}
                          >
                            {busy === d.id ? "…" : "Rendre"}
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {outgoingDelegations.length > 0 && (
                  <ul className="delegation-active-list">
                    {outgoingDelegations.map((d) => (
                      <li key={d.id} className="delegation-active">
                        <p className="tiny">
                          Délégué à <strong>{d.delegateName}</strong> jusqu'au{" "}
                          {new Date(d.expiresAt).toLocaleString("fr-FR", {
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                          .
                        </p>
                        {extending === d.delegateId ? (
                          // Choix de la durée de prolongation, inline : « Prolonger » a
                          // laissé place aux préréglages (échéance ACTUELLE + durée).
                          <div className="delegation-row-actions">
                            {DELEGATION_DURATIONS.map((opt) => (
                              <button
                                key={opt.hours}
                                className="secondary"
                                onClick={() => extendDelegation(d.id, d.delegateId, opt.hours)}
                                disabled={busy !== null}
                                title={`Ajoute ${opt.label} à l'échéance actuelle`}
                              >
                                {busy === d.id ? "…" : `+${opt.label}`}
                              </button>
                            ))}
                            <button
                              className="secondary icon-btn"
                              onClick={() => setExtending(null)}
                              disabled={busy !== null}
                              aria-label="Annuler la prolongation"
                              title="Annuler"
                            >
                              ✕
                            </button>
                          </div>
                        ) : (
                          <div className="delegation-row-actions">
                            <button
                              className="secondary"
                              onClick={() => setExtending(d.delegateId)}
                              disabled={busy !== null}
                            >
                              Prolonger
                            </button>
                            <button
                              className="secondary"
                              onClick={() => revokeDelegation(d.id)}
                              disabled={busy !== null}
                            >
                              {busy === d.id ? "…" : "Révoquer"}
                            </button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {/* État par défaut de la section : ce qui est EN COURS, et rien d'autre. La
                    liste des délégués possibles ne s'ouvre qu'à la demande, sous l'interrupteur
                    ci-dessous. */}
                {outgoingDelegations.length === 0 && (
                  <p className="muted tiny">Tu n'as délégué tes droits à personne.</p>
                )}
                {delegateMembers === null ? (
                  <p className="muted tiny">Chargement…</p>
                ) : availableDelegates.length === 0 ? (
                  outgoingDelegations.length === 0 ? (
                    <p className="muted tiny">Aucun autre membre disponible pour l'instant.</p>
                  ) : null
                ) : (
                  <>
                    <button
                      type="button"
                      className="secondary delegate-toggle"
                      aria-expanded={pickerOpen}
                      disabled={busy !== null}
                      onClick={() => (pickerOpen ? closePicker() : setPickerOpen(true))}
                    >
                      {pickerOpen ? "✕ Annuler" : "+ Déléguer à un membre"}
                    </button>
                    {pickerOpen && (
                      <div className="delegation-form">
                        <input
                          type="search"
                          className="delegate-search"
                          value={delegateQuery}
                          onChange={(e) => setDelegateQuery(e.target.value)}
                          placeholder="Chercher un membre"
                          aria-label="Filtrer la liste des membres"
                          autoComplete="off"
                        />
                        <div
                          className="delegate-picklist"
                          role="group"
                          aria-label="Choisir un ou plusieurs délégués"
                        >
                          {shownDelegates.length === 0 ? (
                            <p className="muted tiny delegate-no-match">
                              Aucun membre à ce nom.
                            </p>
                          ) : (
                            shownDelegates.map((m) => (
                              <label key={m.id} className="check-row">
                                <input
                                  type="checkbox"
                                  checked={pickedDelegates.includes(m.id)}
                                  onChange={(e) => toggleDelegate(m.id, e.target.checked)}
                                />
                                <span>{m.name}</span>
                              </label>
                            ))
                          )}
                        </div>
                        <select
                          value={pickedHours}
                          onChange={(e) => setPickedHours(Number(e.target.value))}
                          aria-label="Durée de la délégation"
                        >
                          {DELEGATION_DURATIONS.map((d) => (
                            <option key={d.hours} value={d.hours}>
                              {d.label}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={createDelegations}
                          disabled={busy !== null || pickedDelegates.length === 0}
                        >
                          {busy === "create"
                            ? "…"
                            : pickedDelegates.length > 1
                              ? `Déléguer (${pickedDelegates.length})`
                              : "Déléguer"}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </section>
            )}

            {showPasskeys && (
              <section className="setting">
                <SettingInfo title="Connexion biométrique">
                  Active Face ID/empreinte pour te reconnecter sans mot de passe sur cet
                  appareil. L'appli ne reçoit qu'une clé de sécurité, pas ton empreinte.
                </SettingInfo>
                {passkeys === null ? (
                  <p className="muted tiny">Chargement…</p>
                ) : (
                  passkeys.length > 0 && (
                    <>
                      {showLockoutWarning && (
                        <p className="tiny" style={{ color: "var(--danger-fg)", margin: "0 0 8px" }}>
                          ⚠️ Tes passkeys sont liés à cet appareil : si tu le perds, tu devras te
                          reconnecter par mot de passe puis les réactiver. Astuce : ajoutes-en un
                          sur un appareil qui synchronise tes passkeys (iCloud / Google).
                        </p>
                      )}
                      <ul className="passkey-list">
                        {passkeys.map((p) => (
                          <li key={p.id} className="passkey-item">
                            <span className="tiny" style={{ minWidth: 0 }}>
                              🔐 {p.deviceLabel || "Cet appareil"}
                              {p.backedUp === true && (
                                <span className="muted" title="Passkey synchronisé (iCloud / Google)">
                                  {" · 🔁 synchronisé"}
                                </span>
                              )}
                              {p.backedUp === false && (
                                <span className="muted" title="Passkey lié à cet appareil uniquement">
                                  {" · 📱 cet appareil"}
                                </span>
                              )}
                              <span className="muted">
                                {" · ajouté le "}
                                {new Date(p.createdAt).toLocaleDateString("fr-FR", {
                                  day: "numeric",
                                  month: "short",
                                })}
                                {p.lastUsedAt
                                  ? ` · vu le ${new Date(p.lastUsedAt).toLocaleDateString("fr-FR", {
                                      day: "numeric",
                                      month: "short",
                                    })}`
                                  : " · jamais utilisé"}
                              </span>
                            </span>
                            <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                              <button
                                className="secondary"
                                onClick={() => renamePasskey(p.id, p.deviceLabel)}
                                disabled={pkBusy}
                                title="Renommer cet appareil"
                              >
                                Renommer
                              </button>
                              <button
                                className="secondary"
                                onClick={() => removePasskey(p.id)}
                                disabled={pkBusy}
                                title="Retirer ce passkey"
                              >
                                Retirer
                              </button>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )
                )}
                {/* L'ajout est TOUJOURS proposé : ni le marqueur local ni la détection du
                    capteur ne sont fiables au point de retirer la seule porte d'entrée.
                    - `pkOnDevice` est un simple drapeau localStorage : il est déjà posé si on
                      s'est connecté ici avec un passkey synchronisé (iCloud/Google) venu d'un
                      AUTRE appareil — le membre se retrouvait alors sans aucune option ;
                    - `passkeySupported()` répond faux sur certains navigateurs intégrés alors
                      que l'enrôlement marcherait.
                    Un vrai doublon est de toute façon refusé par WebAuthn lui-même
                    (excludeCredentials → « déjà enregistré sur cet appareil »). */}
                <button
                  className={enabledOnThisDevice || !pkSupported ? "secondary" : undefined}
                  onClick={addPasskey}
                  disabled={pkBusy}
                >
                  {pkBusy
                    ? "…"
                    : enabledOnThisDevice
                      ? "Ajouter cet appareil"
                      : "Activer sur cet appareil"}
                </button>
                {!pkSupported && (
                  <p className="muted tiny" style={{ marginTop: 6 }}>
                    Cet appareil ne semble pas proposer Face ID / empreinte : l'activation peut
                    échouer (c'est fait pour le téléphone).
                  </p>
                )}
              </section>
            )}

            {/* Notifications — cette section MANQUAIT. On ne pouvait s'abonner qu'en effet de
                bord, en rejoignant la liste d'attente d'un créneau, et on ne pouvait pas se
                désabonner du tout. Personne ne pouvait donc savoir où il en était. */}
            <section className="setting">
              <SettingInfo title="Notifications">
                Terrain libéré, annonces du club, suivi des rencontres. L&apos;autorisation est
                propre à CET appareil et à ce navigateur — l&apos;activer sur le téléphone ne
                l&apos;active pas sur l&apos;ordinateur.
              </SettingInfo>

              {!pushSupported() ? (
                <p className="muted tiny">
                  Ce navigateur ne gère pas les notifications. Sur iPhone, il faut d&apos;abord
                  ajouter l&apos;appli à l&apos;écran d&apos;accueil : Safari seul ne les reçoit
                  pas.
                </p>
              ) : !pushEnabledOnServer() ? (
                <p className="muted tiny">
                  Les notifications ne sont pas configurées sur cet environnement.
                </p>
              ) : pushState === null ? (
                <p className="muted tiny">Vérification…</p>
              ) : pushState.permission === "denied" ? (
                <p className="muted tiny">
                  Elles sont bloquées pour ce site dans les réglages du navigateur. Il faut les
                  y réautoriser — l&apos;appli ne peut plus le demander elle-même une fois le
                  refus enregistré.
                </p>
              ) : pushState.subscribed ? (
                <>
                  <p className="muted tiny">✓ Cet appareil est abonné.</p>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {/* Le seul contrôle qui tranche : la chaîne compte cinq maillons, et un
                        envoi collectif ne dit pas lequel a lâché. Ici on vise cet appareil-ci. */}
                    <button
                      type="button"
                      disabled={pushBusy}
                      onClick={async () => {
                        setPushBusy(true);
                        try {
                          const res = await fetch("/api/push/test", { method: "POST" });
                          const d = (await res.json().catch(() => ({}))) as {
                            devices?: number;
                            sent?: number;
                            error?: string;
                          };
                          if (!res.ok) toast("err", d.error ?? "Envoi impossible.");
                          else if ((d.devices ?? 0) === 0)
                            toast("err", "Aucun appareil enregistré pour ton compte.");
                          else if ((d.sent ?? 0) === 0)
                            toast("err", "Le service de notifications a refusé l'envoi.");
                          else
                            // Ce message est la MOITIÉ UTILE du diagnostic : arrivé ici, la
                            // notification est partie et le service de push l'a acceptée. Tout
                            // ce qui peut encore la retenir est hors de l'appli. Il disait
                            // « les réglages du téléphone » — sur l'ordinateur d'où l'on teste
                            // le plus souvent, il envoyait donc chercher au mauvais endroit,
                            // exactement quand il fallait aller au bon (Windows coupe les
                            // notifications d'une application entière depuis sa propre
                            // bannière, d'un clic, et Chrome s'y retrouve désactivé sans que
                            // rien dans le navigateur ne le dise).
                            //
                            // On nomme donc les DEUX porteurs possibles : le navigateur, et
                            // l'appli installée — sur iPhone comme sur Android, une PWA posée
                            // sur l'écran d'accueil a sa propre ligne dans les réglages, sous
                            // son nom à elle et non sous celui du navigateur.
                            toast(
                              "info",
                              `Envoyée à ${d.sent} appareil${(d.sent ?? 0) > 1 ? "s" : ""}. Rien ne s'affiche ? C'est l'appareil qui bloque : dans ses réglages système, autorise les notifications du navigateur — ou de l'appli, si tu l'as installée.`,
                            );
                        } catch {
                          toast("err", "Envoi impossible.");
                        } finally {
                          setPushBusy(false);
                        }
                      }}
                    >
                      {pushBusy ? "…" : "Tester"}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={pushBusy}
                      onClick={async () => {
                        setPushBusy(true);
                        const ok = await unsubscribePush();
                        setPushState(await pushSubscriptionState());
                        setPushBusy(false);
                        toast(ok ? "ok" : "err", ok ? "Notifications coupées." : "Échec du désabonnement.");
                      }}
                    >
                      Ne plus recevoir
                    </button>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  disabled={pushBusy}
                  onClick={async () => {
                    setPushBusy(true);
                    const ok = await ensurePushSubscribed();
                    setPushState(await pushSubscriptionState());
                    setPushBusy(false);
                    toast(
                      ok ? "ok" : "err",
                      ok
                        ? "Notifications activées sur cet appareil."
                        : "Autorisation refusée — rien ne sera envoyé.",
                    );
                  }}
                >
                  {pushBusy ? "…" : "Activer les notifications"}
                </button>
              )}
            </section>

            <section className="setting">
              <SettingInfo title="Son de confirmation">
                Joue un petit jingle quand une réservation est confirmée. Sur iPhone, le son
                suit l'interrupteur silencieux du téléphone.
              </SettingInfo>
              <label className="check-row">
                <input
                  type="checkbox"
                  role="switch"
                  checked={soundOn}
                  onChange={(e) => toggleSound(e.target.checked)}
                />
                <span>Son à la réservation</span>
              </label>
            </section>

            <section className="setting comment-section">
              <h4>Un commentaire ?</h4>
              <div
                className="muted tiny comment-count"
                style={{ textAlign: "right" }}
                aria-live="polite"
              >
                {comment.length} / {COMMENT_MAX}
              </div>
              <textarea
                className="comment-field"
                aria-label="Ton commentaire"
                value={comment}
                maxLength={COMMENT_MAX}
                rows={3}
                placeholder="Une question, une idée, un bug ? Écris-le ici"
                onChange={(e) => setComment(e.target.value)}
              />
              <button
                className="comment-send"
                onClick={sendComment}
                disabled={sending || !comment.trim()}
              >
                {sending ? "Envoi…" : "Envoyer"}
              </button>
            </section>

            <div className="modal-actions">
              <button className="secondary" onClick={() => setOpen(false)}>
                Fermer
              </button>
            </div>
        </Dialog>
      )}
    </>
  );
}
