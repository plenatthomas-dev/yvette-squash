"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import type { PlanningDay, Slot } from "@/lib/resamania/types";
import { PlanningGrid } from "@/components/PlanningGrid";
import { WeekGrid } from "@/components/WeekGrid";
import { Dialog } from "@/components/Dialog";
import { SettingsButton } from "@/components/SettingsButton";
import { PasskeyEnrollPrompt } from "@/components/PasskeyEnrollPrompt";
import { DirectoryModal } from "@/components/DirectoryModal";
import { PrivacyNotice } from "@/components/PrivacyNotice";
import { ShareModal } from "@/components/ShareModal";
import { HeaderMenu } from "@/components/HeaderMenu";
import { LoginScreen } from "@/components/LoginScreen";
import { LegendInfo } from "@/components/LegendInfo";
import { Skeleton, EmptyState } from "@/components/Placeholders";
import { Toasts, type Toast, type ToastType } from "@/components/Toasts";
import { ConfirmDialog, type ConfirmOpts, type ConfirmState } from "@/components/ConfirmDialog";
import {
  LogoutIcon,
  EuroIcon,
  TrophyIcon,
  TeamsIcon,
  BellIcon,
  UsersIcon,
  ShareIcon,
  RefreshIcon,
  CalendarIcon,
  MultiSelectIcon,
} from "@/components/icons";
// Tricount chargé à la demande (seulement à l'ouverture de la vue « Frais ») : son JS ne
// pèse plus sur le bundle initial de la page. Rendu client uniquement (déjà dans "use client").
const Tricount = dynamic(() => import("@/components/Tricount"), { ssr: false });
// Idem pour le module Tournoi (vue « Tournoi ») : chargé seulement à l'ouverture.
const Tournament = dynamic(() => import("@/components/Tournament"), { ssr: false });
const Interclub = dynamic(() => import("@/components/Interclub"), { ssr: false });
import { fmtTime, slotMinutes, stampFR } from "@/lib/time";
import { NOTIFICATION_RETENTION_DAYS } from "@/lib/notifications-shared";
import { downloadIcs } from "@/lib/ics";
import {
  ensurePushSubscribed,
  pushSupported,
  pushEnabledOnServer,
} from "@/lib/pushClient";
import { useFeatures } from "@/components/FeatureProvider";
import { recheckBanner } from "@/components/AnnouncementBanner";
import { reportMaintenance } from "@/lib/apiFetch";
import { unlockAudio, playSuccessJingle, playError, playAlert } from "@/lib/sound";

function toISODate(d: Date): string {
  return d.toLocaleDateString("en-CA"); // YYYY-MM-DD local
}
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}
// Jour sur lequel l'app s'ouvre par défaut : aujourd'hui, ou DEMAIN s'il est déjà tard
// (≥ 21 h), car il ne reste alors plus guère de créneaux jouables le soir même.
function defaultOpenDate(): string {
  const now = new Date();
  const today = toISODate(now);
  return now.getHours() >= 21 ? addDays(today, 1) : today;
}
function prettyDate(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}
// Format compact pour la barre d'outils (« mer. 1 juil. »), plus économe en largeur.
function shortPretty(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("fr-FR", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}
// Mot RELATIF pour la date affichée (« Auj. », « Demain »), ou null.
//
// Pourquoi c'est nécessaire : `defaultOpenDate()` ouvre sur DEMAIN à partir de 21 h. La
// règle est bonne — après 21 h on cherche un créneau pour le lendemain — mais elle déplace
// le contexte de l'utilisateur sans le lui dire. Le seul indice était que la pastille
// « Auj. » cessait d'être grisée : une différence d'opacité sur un bouton de 0,8 rem.
// À 21 h 15, on ouvre l'appli pour voir s'il reste un terrain CE SOIR, on voit une grille
// pleine de vert, on réserve — et on a réservé pour demain. C'est l'erreur de mode
// classique, sur la question centrale du produit.
function relativeDay(date: string): string | null {
  const today = new Date().toLocaleDateString("en-CA");
  if (date === today) return "Auj.";
  const t = new Date(`${today}T12:00:00`);
  t.setDate(t.getDate() + 1);
  if (date === t.toLocaleDateString("en-CA")) return "Demain";
  return null;
}
// --- Semaine -----------------------------------------------------------------
function mondayOf(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  const off = (d.getDay() + 6) % 7; // 0 = lundi
  d.setDate(d.getDate() - off);
  return toISODate(d);
}
function weekLabel(date: string): string {
  const mon = mondayOf(date);
  const sun = addDays(mon, 6);
  const f = (d: string) =>
    new Date(`${d}T12:00:00`).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  return `${f(mon)} – ${f(sun)}`;
}

// --- Filtre de plage horaire -------------------------------------------------
type Range = "all" | "morning" | "afternoon" | "evening";
const RANGES: { key: Range; label: string }[] = [
  { key: "all", label: "Journée" },
  { key: "morning", label: "Matin" },
  { key: "afternoon", label: "Après-midi" },
  { key: "evening", label: "Soir" },
];
function isRange(v: unknown): v is Range {
  return v === "all" || v === "morning" || v === "afternoon" || v === "evening";
}
function inRange(iso: string, r: Range): boolean {
  const t = slotMinutes(iso);
  switch (r) {
    case "morning": // 9h00 → 12h30 inclus
      return t >= 9 * 60 && t <= 12 * 60 + 30;
    case "afternoon": // 13h00 → 16h30 inclus
      return t >= 13 * 60 && t <= 16 * 60 + 30;
    case "evening": // à partir de 17h00
      return t >= 17 * 60;
    default:
      return true;
  }
}

// Nom du module ouvert, affiché dans le bouton de retour de l'en-tête. Hors du composant :
// c'est une constante, elle n'a pas à être reconstruite à chaque rendu.
const SPECIAL_LABEL: Record<string, string> = {
  money: "Frais partagés",
  tourney: "Tournois",
  interclub: "Interclub",
};

interface JournalEntry {
  id: string;
  displayName: string;
  courtName: string;
  startsAt: string;
  endsAt: string;
  mine: boolean;
  // "app" = réservé depuis l'appli ; "resamania" = réservé directement sur ResaMania et
  // détecté par la réconciliation du planning. Absent des réponses d'avant cette fonction
  // (et des serveurs où le flag `externalBookings` est coupé) ⇒ traité comme "app".
  source?: "app" | "resamania";
  // Non null si je peux annuler cette résa au nom d'un délégant (= son userId à passer en
  // onBehalfOf). Permet à un délégataire — dont un compte « email seul » — de gérer la résa.
  manageableOnBehalfOf?: string | null;
}

interface AlertItem {
  id: string;
  date: string; // YYYY-MM-DD
  hm: string; // HH:MM
  count?: number; // total d'inscrits en liste d'attente sur ce créneau
  position?: number; // mon rang (1 = 1ᵉʳ inscrit)
}

// Plancher d'affichage de l'écran de chargement initial (ms). La durée RÉELLE de cet écran =
// le plus LONG entre ce plancher et le temps de réponse de /api/auth/me : on ne peut pas
// descendre sous le temps du fetch (c'est le vrai travail), ce plancher ne fait que lisser le
// cas « session déjà en cache » où la réponse arrive en quelques ms (sinon le logo clignote).
const SPLASH_MIN_MS = 250;

export default function Home() {
  const { tricount, directory, delegation, tournament, interclub } = useFeatures();
  const [me, setMe] = useState<string | null | undefined>(undefined); // undefined = chargement
  const [splashDone, setSplashDone] = useState(false); // plancher anti-flash de l'écran de chargement écoulé
  const [myId, setMyId] = useState<string | null>(null); // id interne (se reconnaître dans l'annuaire)
  const [myHandle, setMyHandle] = useState<string>(""); // token créneau (pseudo tronqué / Tho.P)
  const [nickname, setNickname] = useState<string | null>(null); // pseudonyme choisi
  const [listed, setListed] = useState(true); // visibilité annuaire (idée 6, opt-out)
  const [canBook, setCanBook] = useState(true); // false = session « email seul » (lecture seule)
  const [isAdmin, setIsAdmin] = useState(false); // admin (allowlist) → entrée « Admin » dans le menu
  const [pendingRequests, setPendingRequests] = useState(0); // demandes d'inscription en attente (badge)
  // Appli fermée par un admin (switch de /admin) : message à afficher, `null` = appli ouverte.
  // Toujours `null` pour un admin — c'est le serveur qui tranche (cf. api/auth/me).
  const [blocked, setBlocked] = useState<string | null>(null);
  const [date, setDate] = useState<string>(() => defaultOpenDate());
  const [planning, setPlanning] = useState<PlanningDay | null>(null);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState<Range>("all");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmState, setConfirmState] = useState<ConfirmState>(null);
  const [view, setView] = useState<"day" | "week" | "money" | "tourney" | "interclub">("day");
  // Vues « plein écran » sans le chrome planning (Frais, Tournoi).
  const isSpecial = view === "money" || view === "tourney" || view === "interclub";
  const [week, setWeek] = useState<{ date: string; planning: PlanningDay }[]>([]);
  const [busy, setBusy] = useState(false);
  // Retour visuel de `busy` DANS la grille. `busy` seul ne se voit nulle part : entre le tap
  // et le toast, l'appel traverse ResaMania sans qu'un pixel bouge, ce qui se lit « ça n'a pas
  // marché » et pousse à retaper (re-taps avalés en silence par le garde anti-double-clic).
  //  - pendingIds : le ou les créneaux réellement engagés → case en attente, inerte ;
  //  - progress   : avancement de la réservation groupée (séquentielle, N allers-retours) ;
  //  - busyVerb   : même information pour les lecteurs d'écran, via un role="status" dédié.
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [busyVerb, setBusyVerb] = useState("");
  // Créneaux qui viennent d'échouer en réservation groupée : la grille les re-coche pour
  // qu'un nouvel essai ne demande pas de reconstituer la sélection de mémoire (la sélection
  // est vidée à la sortie du mode). Un nouveau tableau à chaque bilan → l'effet se rejoue.
  const [failedSel, setFailedSel] = useState<string[]>([]);
  // Mode « sélection multiple » (piloté depuis la barre de vue, appliqué dans la grille
  // affichée). Remonté ici pour que le bouton bascule vive dans la barre d'outils compacte.
  const [selMode, setSelMode] = useState(false);
  // Hydratation : on ne charge la donnée et on n'écrit l'URL/localStorage qu'après avoir lu
  // l'état initial (URL puis localStorage). Évite un double chargement au premier rendu.
  const [hydrated, setHydrated] = useState(false);
  const lastFocusRef = useRef(0);
  const dateInputRef = useRef<HTMLInputElement>(null);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [alertsOpen, setAlertsOpen] = useState(false);
  // Journal des notifications, affiché sous la même cloche. C'est le REPLI du push : il
  // fonctionne que le téléphone ait reçu quelque chose ou non.
  const [notifs, setNotifs] = useState<
    {
      id: string;
      title: string;
      body: string;
      url: string | null;
      at: string;
      read: boolean;
      /** Lignes que cette entrée représente (série de même `tag`). 1 = notification isolée. */
      count: number;
    }[]
  >([]);
  const [unread, setUnread] = useState(0);
  const [confirmWipe, setConfirmWipe] = useState(false);
  // Liste d'attente (idée D) : nombre d'inscrits par créneau ("YYYY-MM-DD|HH:MM" -> n),
  // pour la plage affichée. Alimenté par /api/alerts/counts, montré à tous.
  const [waitCounts, setWaitCounts] = useState<Record<string, number>>({});
  // Badge € : nombre de tricounts où JE dois de l'argent et où les remboursements
  // sont ouverts (action possible « rembourser »). Alimenté au chargement/focus et,
  // en direct, par le composant Tricount quand la vue Frais est ouverte.
  const [triOwed, setTriOwed] = useState(0);
  // Délégation (idée 4) : délégations entrantes actives (plusieurs membres peuvent m'avoir
  // délégué leurs droits simultanément) + pour qui j'agis actuellement (null = moi-même).
  const [incomingDelegations, setIncomingDelegations] = useState<
    { delegatorId: string; delegatorName: string; expiresAt: string }[]
  >([]);
  const [actingAsId, setActingAsId] = useState<string | null>(null);
  // Bandeaux « on t'a délégué des droits » : un par délégant, masquables individuellement.
  // Chaque bandeau masqué est mémorisé par une clé identité (délégant + échéance) → il se
  // ré-affiche si la délégation change (nouvelle échéance) ou si un nouveau délégant arrive.
  const [delegBannerDismissed, setDelegBannerDismissed] = useState<string[]>([]);
  // Modales du menu ⋯ (partage / annuaire), pilotées depuis HeaderMenu.
  const [shareOpen, setShareOpen] = useState(false);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const today = toISODate(new Date());
  // Notifications disponibles seulement une fois monté (évite un décalage d'hydratation)
  // ET si le navigateur les supporte ET si les clés VAPID sont configurées côté serveur.
  const canNotify = hydrated && pushSupported() && pushEnabledOnServer();

  // Ouvre le calendrier natif depuis le libellé de date (champ input masqué).
  const openDatePicker = () => {
    const el = dateInputRef.current;
    if (!el) return;
    try {
      el.showPicker?.();
    } catch {
      el.focus(); // showPicker non supporté / hors geste utilisateur
    }
  };

  const toast = useCallback((type: ToastType, msg: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, type, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  const askConfirm = useCallback(
    (opts: ConfirmOpts) =>
      new Promise<boolean>((resolve) => setConfirmState({ ...opts, resolve })),
    [],
  );
  const resolveConfirm = (v: boolean) => {
    confirmState?.resolve(v);
    setConfirmState(null);
  };

  const checkMe = useCallback(async () => {
    let res: Response;
    try {
      res = await fetch("/api/auth/me");
    } catch {
      // Serveur/réseau injoignable au démarrage : possible indisponibilité de la base → on laisse
      // la bannière de maintenance confirmer (via /api/health) et on retombe sur l'écran de login.
      reportMaintenance();
      setMe(null);
      return;
    }
    if (res.ok) {
      const data = await res.json();
      setMe(data.displayName);
      setMyId(data.id ?? null);
      setMyHandle(data.handle ?? "");
      setNickname(data.nickname ?? null);
      setListed(data.listed ?? true);
      setCanBook(data.canBook ?? true);
      setIsAdmin(data.isAdmin ?? false);
      setPendingRequests(data.pendingRequests ?? 0);
      setBlocked(data.blocked ?? null);
    } else {
      // 401 = simplement pas connecté (cas normal). Un 5xx, lui, trahit une panne serveur —
      // typiquement la base à terre : on signale la maintenance (la bannière confirmera).
      if (res.status >= 500) reportMaintenance();
      setMe(null);
      setMyId(null);
      setMyHandle("");
      setNickname(null);
    }
  }, []);

  useEffect(() => {
    checkMe();
  }, [checkMe]);

  // Plancher anti-flash de l'écran de chargement : au bout de SPLASH_MIN_MS, on autorise le
  // passage à l'appli (le rendu attend AUSSI que /api/auth/me ait répondu — cf. `me`).
  useEffect(() => {
    const t = setTimeout(() => setSplashDone(true), SPLASH_MIN_MS);
    return () => clearTimeout(t);
  }, []);

  // Déverrouille l'audio dès le premier geste utilisateur (requis par iOS) pour que le jingle
  // de confirmation de réservation puisse être joué ensuite, même après un appel réseau.
  useEffect(() => {
    unlockAudio();
  }, []);

  // Une seule requête sert la liste ET la pastille. Chargée pour TOUT membre connecté, sans
  // condition sur le push : la cloche doit précisément renseigner ceux qui ne le reçoivent pas.
  const loadNotifs = useCallback(async () => {
    try {
      const r = await fetch("/api/notifications", { cache: "no-store" });
      if (!r.ok) return;
      const d = (await r.json()) as { items: typeof notifs; unread: number };
      setNotifs(d.items);
      setUnread(d.unread);
    } catch {
      /* la cloche est un confort : son échec ne doit rien interrompre */
    }
    // `notifs` n'est pas une dépendance : il n'est ici qu'un type, jamais lu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Alerte « terrain libéré » quand l'appli est OUVERTE : le service worker relaie la notification
  // push par postMessage (cf. public/sw.js), on joue alors le son d'alerte. Appli fermée : c'est
  // la notification système qui sonne (le navigateur ne nous laisse pas jouer notre son).
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if (!e.data) return;
      if (e.data.type === "slot-free") playAlert();
      // Un push vient d'arriver : la cloche se met à jour sur-le-champ, sans attendre que
      // l'utilisateur recharge la page.
      if (e.data.type === "push-received") loadNotifs();
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [loadNotifs]);

  const loadAlerts = useCallback(async () => {
    const r = await fetch("/api/alerts");
    if (r.ok) setAlerts(await r.json());
  }, []);

  useEffect(() => {
    if (me) loadNotifs();
  }, [me, loadNotifs]);

  // Rafraîchissement au retour sur l'appli. SANS throttle et avec `pageshow`, exactement
  // comme la pastille « Admin — demandes » plus bas : une première version throttlée à 15 s
  // et sourde au bfcache rendait l'arrivée des notifications imprévisible — un aller-retour
  // rapide laissait la cloche périmée, et un retour par le bouton « précédent » ne
  // déclenchait rien du tout. C'est une requête minuscule sur un index, elle ne mérite pas
  // qu'on la rationne.
  useEffect(() => {
    if (!me) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") loadNotifs();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", loadNotifs);
    return () => {
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", loadNotifs);
    };
  }, [me, loadNotifs]);

  useEffect(() => {
    if (me && canNotify) loadAlerts();
  }, [me, canNotify, loadAlerts]);

  // Compteurs « N en attente » pour la plage [from, to] (jour : from==to).
  const loadWaitCounts = useCallback(async (from: string, to: string) => {
    const r = await fetch(`/api/alerts/counts?from=${from}&to=${to}`);
    if (r.ok) setWaitCounts(await r.json());
    else setWaitCounts({});
  }, []);

  // Compteur du badge € : tricounts où je dois de l'argent, remboursements ouverts.
  //
  // Il appelait `/api/tricount` — l'historique complet, avec ses dépenses, ses parts, ses
  // validations, ses commentaires et ses invités — pour n'en garder qu'un entier, à CHAQUE
  // chargement de l'appli et pour chaque membre. Et il ne comptait que la fenêtre paginée :
  // une dette plus ancienne que les 25 derniers tricounts faisait disparaître le badge.
  // `/api/tricount/summary` répond les deux chiffres par des requêtes étroites, sur tout
  // l'historique.
  const loadTriOwed = useCallback(async () => {
    const r = await fetch("/api/tricount/summary");
    if (!r.ok) return;
    const d = (await r.json()) as { globalCents: number; owedCount: number };
    setTriOwed(d.owedCount);
  }, []);
  useEffect(() => {
    if (me && tricount) loadTriOwed();
  }, [me, tricount, loadTriOwed]);

  // Délégation reçue (idée 4) : si un autre membre m'a délégué ses droits, je peux agir
  // « en son nom ». `actingAs` = pour qui j'agis actuellement (null = moi-même).
  const loadIncomingDelegation = useCallback(async () => {
    const r = await fetch("/api/delegations");
    if (!r.ok) {
      setIncomingDelegations([]);
      return;
    }
    const d = (await r.json()) as {
      incoming: { delegatorId: string; delegatorName: string; expiresAt: string }[];
    };
    setIncomingDelegations(d.incoming ?? []);
  }, []);
  useEffect(() => {
    if (me && delegation) loadIncomingDelegation();
  }, [me, delegation, loadIncomingDelegation]);
  // Sécurité : si le délégant sélectionné n'est plus dans les délégations entrantes actives
  // (révoquée, expirée), on retombe sur « moi-même ».
  useEffect(() => {
    if (actingAsId && !incomingDelegations.some((d) => d.delegatorId === actingAsId)) {
      setActingAsId(null);
    }
  }, [actingAsId, incomingDelegations]);

  const load = useCallback(
    // `fresh` : on vient de réserver ou d'annuler et on attend de VOIR le résultat. Le cache
    // planning vit en mémoire de process : l'invalidation faite par la route d'écriture ne
    // vaut que pour SON instance serverless, et ce GET peut tomber ailleurs (cf. getPlanning).
    async (d: string, fresh = false) => {
      setLoading(true);
      setError(null);
      try {
        // Séquentiel à dessein : /api/planning réconcilie la base (résas annulées ailleurs),
        // puis /api/bookings lit un journal déjà à jour.
        const pr = await fetch(`/api/planning?date=${d}${fresh ? "&fresh=1" : ""}`);
        if (pr.status === 401) {
          setMe(null);
          return;
        }
        const pdata = await pr.json();
        if (!pr.ok) throw new Error(pdata.error ?? `Erreur ${pr.status}`);
        setPlanning(pdata);
        const jr = await fetch(`/api/bookings?date=${d}`);
        setJournal(jr.ok ? await jr.json() : []);
        loadWaitCounts(d, d);
      } catch (e) {
        setError((e as Error).message);
        setPlanning(null);
      } finally {
        setLoading(false);
      }
    },
    [loadWaitCounts],
  );

  const loadWeek = useCallback(async (d: string, fresh = false) => {
    setLoading(true);
    setError(null);
    try {
      // Un seul appel : /api/week renvoie les 7 jours (planning brut, sans réconciliation).
      const r = await fetch(`/api/week?date=${d}${fresh ? "&fresh=1" : ""}`);
      if (r.status === 401) {
        setMe(null);
        return;
      }
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `Erreur ${r.status}`);
      const wk = j as { date: string; planning: PlanningDay }[];
      setWeek(wk);
      if (wk.length) loadWaitCounts(wk[0].date, wk[wk.length - 1].date);
    } catch (e) {
      setError((e as Error).message);
      setWeek([]);
    } finally {
      setLoading(false);
    }
  }, [loadWaitCounts]);

  // Lecture de l'état initial : `view`/`range` depuis l'URL (sinon localStorage). La DATE
  // n'est volontairement PAS restaurée : l'app s'ouvre toujours sur le jour par défaut
  // (aujourd'hui, ou demain après 21 h — cf. defaultOpenDate), pas sur le dernier jour vu.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);

    const isView = (x: string | null): x is "day" | "week" | "money" | "tourney" | "interclub" =>
      x === "day" || x === "week" || x === "money" || x === "tourney" || x === "interclub";
    const vParam = p.get("view");
    const vLS = localStorage.getItem("view");
    let v = isView(vParam) ? vParam : isView(vLS) ? vLS : null;
    // Les vues gated (Frais/Tournoi) sont ramenées à « day » par l'effet correctif plus bas :
    // il couvre aussi la coupure d'un flag EN COURS de session, pas seulement le démarrage.
    // Au LANCEMENT, on n'ouvre jamais directement la vue Semaine : /api/week (7 fetches
    // ResaMania) est lourd sur le chemin critique du démarrage. La Semaine reste à un clic
    // une fois l'appli chargée. (Comme la DATE, ce n'est volontairement pas restauré.)
    if (v === "week") v = "day";
    if (v) setView(v);

    const rParam = p.get("range");
    const rLS = localStorage.getItem("range");
    const r = isRange(rParam) ? rParam : isRange(rLS) ? rLS : null;
    if (r) setRange(r);

    setHydrated(true);
  }, []);

  // Une vue dont la fonction est coupée ne doit jamais rester à l'écran : au démarrage
  // (vue restaurée depuis l'URL/localStorage) comme après une coupure à chaud par un admin.
  useEffect(() => {
    if (view === "money" && !tricount) setView("day");
    if (view === "tourney" && !tournament) setView("day");
    if (view === "interclub" && !interclub) setView("day");
  }, [view, tricount, tournament, interclub]);

  // Reflète l'état dans l'URL (partageable, survit au refresh) et le persiste.
  useEffect(() => {
    if (!hydrated) return;
    const p = new URLSearchParams();
    p.set("date", date);
    p.set("view", view);
    if (range !== "all") p.set("range", range);
    window.history.replaceState(null, "", `${window.location.pathname}?${p.toString()}`);
    localStorage.setItem("view", view);
    localStorage.setItem("range", range);
  }, [hydrated, date, view, range]);

  useEffect(() => {
    if (!me || !hydrated) return;
    if (view === "money" || view === "tourney" || view === "interclub") return; // ces vues chargent leurs propres données
    if (view === "week") loadWeek(date);
    else load(date);
  }, [me, hydrated, date, view, load, loadWeek]);

  // On sort du mode « sélection multiple » dès qu'on change de vue ou de date,
  // pour ne pas traîner une sélection devenue hors contexte.
  useEffect(() => {
    setSelMode(false);
  }, [view, date]);

  // `fresh` à passer APRÈS une mutation (réservation, annulation) : sans lui, le GET peut
  // être servi par le cache mémoire d'une instance serverless qui n'a pas vu l'écriture, et
  // la grille reste inchangée jusqu'à expiration du TTL (20 s) — le symptôme « il faut
  // actualiser plusieurs fois ».
  const reload = useCallback(
    (fresh = false) => {
      if (view === "money" || view === "tourney" || view === "interclub") return; // ces vues se rechargent seules
      if (view === "week") loadWeek(date, fresh);
      else load(date, fresh);
    },
    [view, date, load, loadWeek],
  );

  // Rafraîchit au retour sur l'onglet (throttle 15 s) : le planning peut avoir bougé
  // pendant l'absence (un autre membre a réservé). Évite de réserver un créneau déjà pris.
  useEffect(() => {
    if (!me) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastFocusRef.current < 15000) return;
      lastFocusRef.current = now;
      reload();
      if (tricount) loadTriOwed(); // le badge € peut avoir changé (validation ailleurs)
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [me, tricount, reload, loadTriOwed]);

  // Le badge « Admin — demandes » peut changer pendant qu'on est sur /admin (approbation /
  // rejet). /admin étant une page séparée, on rafraîchit le compteur au retour sur l'appli —
  // SANS le throttle de 15 s ci-dessus (sinon un aller-retour rapide laisse la pastille périmée)
  // et en écoutant `pageshow` (retour via le bouton « précédent » depuis le bfcache).
  useEffect(() => {
    if (!me || !isAdmin) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") checkMe();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", checkMe);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", checkMe);
    };
  }, [me, isAdmin, checkMe]);

  const pickDay = (d: string) => {
    setView("day");
    setDate(d);
  };

  // Détecte une session expirée (401) et renvoie vers le login proprement.
  //
  // ⚠️ MÉMOÏSÉ, ET CE N'EST PAS UN CONFORT. Cette fonction descend en `onExpired` dans
  // `Interclub`, `Tournament` et `Tricount`, où elle sert de DÉPENDANCE à des `useCallback` de
  // chargement, eux-mêmes dépendances de `useEffect`. Déclarée en fonction nue, son identité
  // changeait à chaque rendu de cette page : chaque rendu relançait donc tous les chargements
  // de l'onglet ouvert, garde-fous compris — `InterclubLive` resondait sans consulter le sien,
  // qui décide justement de NE PAS sonder les jours sans rencontre.
  //
  // Pire, le cycle se refermait sur lui-même : le `catch` d'un chargeur toaste, `toast` écrit
  // l'état de CETTE page, le rendu qui suit recrée `handleExpired`, l'effet se rejoue, la
  // requête échoue encore. Base en veille ou téléphone hors réseau, sur l'onglet Interclub, et
  // l'appli partait en boucle de requêtes sans fin — plus une sonde `/api/health` par tour,
  // exactement quand la base souffrait déjà.
  //
  // `toast` est lui-même mémoïsé (cf. plus haut) et `setMe` est stable : la liste de
  // dépendances est donc réellement close. NE PAS la rouvrir.
  const handleExpired = useCallback(
    (status: number): boolean => {
      if (status === 401) {
        setMe(null);
        toast("err", "Session expirée — reconnecte-toi.");
        return true;
      }
      return false;
    },
    [toast],
  );

  // On peut réserver soit avec son propre compte ResaMania, soit en agissant pour un
  // délégant (on emprunte SON jeton, cf. resolveActingContext côté serveur). Donc un compte
  // « email seul » (canBook=false) PEUT réserver dès qu'il a sélectionné « Pour <délégant> » :
  // sans ce OU, le garde de lecture seule le bloquait alors que l'API l'autorise.
  const canBookNow = canBook || actingAsId !== null;

  // Nom du délégant pour qui on agit (si « Pour <délégant> » est sélectionné), rappelé dans
  // les confirmations pour lever toute ambiguïté sur le compte réellement engagé.
  const actingForName = actingAsId
    ? incomingDelegations.find((d) => d.delegatorId === actingAsId)?.delegatorName ?? null
    : null;

  const onBook = async (slot: Slot) => {
    if (busy || confirmState) return; // anti double-clic / double-modale
    if (!canBookNow) {
      toast(
        "info",
        "Réservation possible seulement via ResaMania. Ici tu peux te mettre « +1 » sur un créneau déjà réservé.",
      );
      return;
    }
    // Blocage « même créneau » : impossible de réserver 2 terrains au même horaire
    // (ResaMania le refuse). On prévient tout de suite si on a déjà une résa à cette heure.
    const clash = planning?.slots.find((s) => s.startsAt === slot.startsAt && s.mine);
    if (clash) {
      toast("info", `Tu joues déjà sur ${clash.courtName} à cet horaire — un seul terrain à la fois.`);
      return;
    }
    const ok = await askConfirm({
      title: actingForName ? `Réserver au nom de ${actingForName} ?` : "Réserver ce créneau ?",
      body: `${slot.courtName} — ${fmtTime(slot.startsAt)} le ${prettyDate(slot.startsAt.slice(0, 10))}`,
      confirmLabel: "Réserver",
    });
    if (!ok) return;
    setBusy(true);
    setPendingIds(new Set([slot.id]));
    setBusyVerb("Réservation en cours…");
    try {
      const res = await fetch("/api/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          classEventId: slot.id,
          courtName: slot.courtName,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          onBehalfOf: actingAsId ?? undefined,
        }),
      });
      if (handleExpired(res.status)) return;
      const data = await res.json();
      if (!res.ok) {
        // Conflit « même créneau » : notif d'information plutôt qu'une erreur.
        if (data.code === "overlap") {
          toast("info", data.error);
          return;
        }
        throw new Error(data.error ?? "le service n'a pas répondu comme prévu");
      }
      toast("ok", "Réservation confirmée");
      playSuccessJingle(); // petit jingle de succès (réglable dans les Paramètres)
      reload(true); // frais : on vient d'écrire, on doit VOIR le créneau changer
    } catch (e) {
      toast("err", "Réservation impossible : " + (e as Error).message);
      playError(); // son d'échec de réservation
    } finally {
      setBusy(false);
      setPendingIds(new Set());
      setBusyVerb("");
    }
  };

  const onCancel = async (b: JournalEntry) => {
    if (busy || confirmState) return;
    // onBehalfOf dérivé de la résa elle-même : sa propre résa → aucun (jeton propre) ; résa d'un
    // délégant → son id (le serveur revérifie la délégation). Indépendant du sélecteur global.
    const onBehalf = b.mine ? undefined : b.manageableOnBehalfOf ?? undefined;
    const ok = await askConfirm({
      title: onBehalf ? `Annuler la réservation de ${b.displayName} ?` : "Annuler la réservation ?",
      body: `${b.courtName} — ${fmtTime(b.startsAt)} le ${prettyDate(date)}`,
      confirmLabel: "Annuler la résa",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/bookings/${b.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ onBehalfOf: onBehalf }),
      });
      if (handleExpired(res.status)) return;
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "le service n'a pas répondu comme prévu");
      toast("ok", "Réservation annulée");
      reload(true); // frais : on vient d'écrire
    } catch (e) {
      toast("err", "Annulation impossible : " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Annulation directement depuis la grille (clic sur son créneau « ★ »).
  const onCancelMine = async (slot: Slot) => {
    if (busy || confirmState) return;
    const ok = await askConfirm({
      title: actingForName ? `Annuler la réservation de ${actingForName} ?` : "Annuler ta réservation ?",
      body: `${slot.courtName} — ${fmtTime(slot.startsAt)} le ${prettyDate(slot.startsAt.slice(0, 10))}`,
      confirmLabel: "Annuler la résa",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setPendingIds(new Set([slot.id]));
    setBusyVerb("Annulation en cours…");
    try {
      const res = await fetch("/api/cancel-slot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classEventId: slot.id, onBehalfOf: actingAsId ?? undefined }),
      });
      if (handleExpired(res.status)) return;
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "le service n'a pas répondu comme prévu");
      toast("ok", "Réservation annulée");
      reload(true); // frais : on vient d'écrire
    } catch (e) {
      toast("err", "Annulation impossible : " + (e as Error).message);
    } finally {
      setBusy(false);
      setPendingIds(new Set());
      setBusyVerb("");
    }
  };

  // Signale/retire sa présence sur le créneau d'un autre membre. Pas de confirmation.
  // Mise à jour optimiste (ton prénom apparaît/disparaît aussitôt), puis re-sync si échec.
  const onTogglePresence = async (slot: Slot) => {
    if (!me) return;
    // Diminutif du joueur courant (Tho.P) : DOIT correspondre à ce que renvoie le
    // serveur dans `attendees`, sinon l'ajout optimiste laisse un doublon après re-sync.
    const myFirst = myHandle || me.split(" ")[0];
    const wasAttending = slot.iAmAttending ?? false;
    setPlanning((p) =>
      p
        ? {
            ...p,
            slots: p.slots.map((s) => {
              // Créneau ciblé : on bascule ma présence.
              if (s.id === slot.id) {
                const cur = s.attendees ?? [];
                return {
                  ...s,
                  attendees: wasAttending ? cur.filter((n) => n !== myFirst) : [...cur, myFirst],
                  iAmAttending: !wasAttending,
                };
              }
              // Ajout : je me retire d'un éventuel autre terrain au même horaire (exclusivité).
              if (!wasAttending && s.startsAt === slot.startsAt && s.iAmAttending) {
                return {
                  ...s,
                  attendees: (s.attendees ?? []).filter((n) => n !== myFirst),
                  iAmAttending: false,
                };
              }
              return s;
            }),
          }
        : p,
    );
    try {
      const res = await fetch("/api/presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classEventId: slot.id, startsAt: slot.startsAt }),
      });
      if (handleExpired(res.status)) return;
      if (!res.ok) throw new Error();
    } catch {
      toast("err", "Présence non enregistrée");
      reload(); // resynchronise l'état réel
    }
  };

  // Présence « +1 » depuis la vue semaine : POST direct puis rechargement de la semaine
  // (l'update optimiste de onTogglePresence cible le planning du jour, pas les 7 jours).
  const onTogglePresenceWeek = async (slot: Slot) => {
    if (!me) return;
    try {
      const res = await fetch("/api/presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classEventId: slot.id, startsAt: slot.startsAt }),
      });
      if (handleExpired(res.status)) return;
      if (!res.ok) throw new Error();
      reload();
    } catch {
      toast("err", "Présence non enregistrée");
    }
  };

  // Réservation groupée (vues jour et semaine) : un /api/book par créneau, en séquence, avec bilan.
  const onBookMany = async (slots: Slot[]) => {
    if (busy || confirmState || slots.length === 0) return;
    if (!canBookNow) {
      toast(
        "info",
        "Réservation possible seulement via ResaMania. Ici tu peux te mettre « +1 » sur un créneau déjà réservé.",
      );
      return;
    }
    const MAX_LINES = 10;
    const lines = slots
      .slice(0, MAX_LINES)
      .map(
        (s) =>
          `${shortPretty(s.startsAt.slice(0, 10))} ${fmtTime(s.startsAt)} — ${s.courtName}`,
      );
    if (slots.length > MAX_LINES) lines.push(`… et ${slots.length - MAX_LINES} autre${slots.length - MAX_LINES > 1 ? "s" : ""}`);
    const ok = await askConfirm({
      title: `Réserver ${slots.length} créneau${slots.length > 1 ? "x" : ""}${actingForName ? ` au nom de ${actingForName}` : ""} ?`,
      body: "Ces terrains seront réservés :",
      lines,
      confirmLabel: "Réserver",
    });
    if (!ok) return;
    setBusy(true);
    setBusyVerb(`Réservation de ${slots.length} créneaux en cours…`);
    setProgress({ done: 0, total: slots.length });
    let done = 0;
    const fails: string[] = [];
    // Créneaux effectivement ratés : on les garde cochés à la sortie (voir plus bas), pour
    // que l'utilisateur puisse retenter sans avoir à recomposer sa sélection de mémoire.
    const failedIds: string[] = [];
    try {
      for (const [i, slot] of slots.entries()) {
        // La case en cours passe en attente ; la barre affiche « Réservation 3 / 7… ».
        setPendingIds(new Set([slot.id]));
        setProgress({ done: i, total: slots.length });
        try {
          const res = await fetch("/api/book", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              classEventId: slot.id,
              courtName: slot.courtName,
              startsAt: slot.startsAt,
              endsAt: slot.endsAt,
              onBehalfOf: actingAsId ?? undefined,
            }),
          });
          if (res.status === 401) {
            handleExpired(401);
            return;
          }
          const data = await res.json().catch(() => ({}));
          if (res.ok) done++;
          else {
            fails.push(
              `${shortPretty(slot.startsAt.slice(0, 10))} ${fmtTime(slot.startsAt)} — ${slot.courtName} : ${data.error ?? `refusé (${res.status})`}`,
            );
            failedIds.push(slot.id);
          }
        } catch {
          fails.push(
            `${shortPretty(slot.startsAt.slice(0, 10))} ${fmtTime(slot.startsAt)} — ${slot.courtName} : réseau indisponible`,
          );
          failedIds.push(slot.id);
        }
      }
    } finally {
      setBusy(false);
      setPendingIds(new Set());
      setProgress(null);
      setBusyVerb("");
    }
    // Tout a réussi : le toast suffit, l'information tient en une phrase.
    if (done > 0 && fails.length === 0) {
      toast("ok", `${done} réservation${done > 1 ? "s" : ""} confirmée${done > 1 ? "s" : ""}`);
      playSuccessJingle();
      reload(true); // frais : N écritures viennent d'avoir lieu
      return;
    }
    // Au moins un échec : le détail créneau-par-créneau existe, il ne doit PAS être jeté dans
    // un toast de 3,5 s intappable. Un membre qui bloque 5 créneaux pour un tournoi et en
    // obtient 3 doit savoir LESQUELS ont raté pour retenter ou prévenir son partenaire.
    if (done > 0) playSuccessJingle();
    else playError();
    setFailedSel(failedIds); // ces créneaux restent cochés dans la grille
    reload(true); // frais : au moins une écriture a abouti
    await askConfirm({
      title:
        done > 0
          ? `${done} réservée${done > 1 ? "s" : ""}, ${fails.length} échouée${fails.length > 1 ? "s" : ""}`
          : `Aucune réservation (${fails.length} échec${fails.length > 1 ? "s" : ""})`,
      body:
        done > 0
          ? "Ces créneaux n'ont pas pu être réservés — ils restent cochés dans la grille :"
          : "Aucun créneau n'a pu être réservé :",
      lines: fails,
      confirmLabel: "Compris",
      noCancel: true,
    });
  };

  // Rafraîchit les compteurs « N en attente » pour la plage actuellement affichée.
  const refreshWaitCounts = useCallback(() => {
    if (view === "week" && week.length) {
      loadWaitCounts(week[0].date, week[week.length - 1].date);
    } else {
      loadWaitCounts(date, date);
    }
  }, [view, week, date, loadWaitCounts]);

  // Liste d'attente (idée D) : s'inscrire pour être prévenu qu'un terrain se libère sur
  // un créneau COMPLET. La résa reste manuelle (notif push quand ça se libère).
  const onWatch = async (slot: Slot) => {
    if (busy || confirmState) return;
    if (!canNotify) {
      toast("err", "Notifications indisponibles sur cet appareil.");
      return;
    }
    const day = slot.startsAt.slice(0, 10);
    // Heure « murale » du club (Europe/Paris), PAS un slice UTC brut : sinon un créneau de
    // 10 h serait stocké/affiché « 08:00 » l'été. Doit rester aligné sur PlanningGrid,
    // WeekGrid et le cron check-alerts (même clé date|hm partout).
    const hm = fmtTime(slot.startsAt);
    const ok = await askConfirm({
      title: "Rejoindre la liste d'attente ?",
      body: `${fmtTime(slot.startsAt)} le ${prettyDate(day)} — on te notifie dès qu'un terrain se libère à cet horaire (réservation manuelle).`,
      confirmLabel: "M'inscrire 🕒",
    });
    if (!ok) return;
    const subscribed = await ensurePushSubscribed();
    if (!subscribed) {
      toast("err", "Autorise les notifications pour recevoir l'alerte.");
      return;
    }
    try {
      const res = await fetch("/api/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: day, hm }),
      });
      if (handleExpired(res.status)) return;
      if (!res.ok) {
        // Le serveur explique parfois précisément le refus (créneau trop lointain, par
        // exemple). Le remplacer par « impossible de rejoindre » ferait passer une règle
        // métier pour une panne, et le membre réessaierait.
        const data = await res.json().catch(() => ({}));
        throw new Error(typeof data.error === "string" ? data.error : "");
      }
      toast("ok", "Inscrit en liste d'attente 🕒");
      loadAlerts();
      refreshWaitCounts();
    } catch (e) {
      toast("err", (e as Error).message || "Impossible de rejoindre la liste d'attente.");
    }
  };

  const cancelAlert = async (id: string) => {
    setAlerts((a) => a.filter((x) => x.id !== id)); // retrait optimiste
    await fetch(`/api/alerts/${id}`, { method: "DELETE" }).catch(() => {});
    loadAlerts();
    refreshWaitCounts();
  };

  // Retrait de la liste d'attente depuis la grille (par créneau, pas par id d'alerte).
  const onUnwatch = (date: string, hm: string) => {
    const a = alerts.find((x) => x.date === date && x.hm === hm);
    if (a) cancelAlert(a.id);
  };

  // Compteur « N en attente » et mon rang pour un créneau (pour les grilles + modale).
  const waitCountFor = (date: string, hm: string) => waitCounts[`${date}|${hm}`] ?? 0;
  const myWaitFor = (date: string, hm: string) =>
    alerts.find((a) => a.date === date && a.hm === hm) ?? null;

  // Se connecter ne remonte pas la bannière (elle vit dans le layout) et ne déclenche aucun
  // focus : sans ce signal, une annonce publiée pendant que l'écran de connexion était ouvert
  // n'apparaîtrait qu'au rechargement.
  const onLoggedIn = () => {
    checkMe();
    recheckBanner();
  };

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    // Réévalue l'annonce en visiteur : on repasse sur le masquage local du navigateur, et la
    // modale disparaît (elle est réservée aux membres connectés).
    recheckBanner();
    setMe(null);
    setPlanning(null);
  };

  // Écran de chargement initial : affiché tant que la session n'est pas connue (me === undefined)
  // ET au moins SPLASH_MIN_MS (plancher anti-flash). On rend le MÊME conteneur et le MÊME logo
  // (place + taille) que l'écran de connexion — cf. LoginScreen / .logo-hero : en enchaînant sur
  // le login, seul le spinner disparaît, le logo ne bouge pas. Le spinner respecte reduced-motion.
  if (me === undefined || !splashDone) {
    return (
      <main className="login">
        <h1 className="sr-only">Squash de l'Yvette</h1>
        <img src="/logo_squash.jpeg" alt="Squash de l'Yvette" className="logo-hero" />
        <div className="app-loading" role="status" aria-live="polite">
          <span className="app-spinner" aria-hidden="true" />
          <span className="sr-only">Chargement…</span>
        </div>
      </main>
    );
  }

  if (me === null) {
    return <LoginScreen onLoggedIn={onLoggedIn} />;
  }

  // Appli fermée par un admin. Les sessions durant 30 jours, bloquer la connexion ne suffit pas :
  // sans cet écran, un membre déjà connecté continuerait d'utiliser l'appli comme si de rien
  // n'était. Les routes de réservation refusent aussi côté serveur (cf. lib/app-block) — cet
  // écran est la porte visible, pas la serrure. L'admin ne le voit jamais (`blocked` reste nul).
  if (blocked) {
    return (
      <main className="login">
        <h1 className="sr-only">Squash de l'Yvette</h1>
        <img src="/logo_squash.jpeg" alt="Squash de l'Yvette" className="logo-hero" />
        <div className="notice warn" role="status" aria-live="polite">
          <strong>🚧 {blocked}</strong>
        </div>
        <p className="muted">
          L&apos;appli est momentanément fermée par le club. Réessaie un peu plus tard.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={() => checkMe()}>
            Réessayer
          </button>
          <button type="button" className="secondary" onClick={logout}>
            Se déconnecter
          </button>
        </div>
      </main>
    );
  }

  return (
    <main>
      <a href="#main-content" className="skip-link">Aller au contenu</a>
      <header className="app">
        <div className="app-top">
          {/* Dans un module (Frais / Tournois / Interclub), l'en-tête devient le RETOUR au
              planning. C'est la sortie qui manquait : jusqu'ici, les onglets Jour/Semaine
              restaient montés dans ces vues uniquement parce qu'ils étaient le seul chemin de
              retour — un contrôle de planning affiché hors du planning, qui n'avait de sens
              que par accident. La flèche est désormais à sa place canonique, en haut à gauche,
              et le libellé dit où l'on se trouve. */}
          <div className="brand">
            <h1>
              {isSpecial ? (
                <button
                  type="button"
                  className="brand-back"
                  onClick={() => setView("day")}
                  title="Retour au planning"
                  aria-label="Retour au planning"
                >
                  <span className="brand-back-arrow" aria-hidden="true">
                    ←
                  </span>
                  <img
                    src="/logo_squash.jpeg"
                    alt=""
                    className="logo-mark"
                    width={46}
                    height={46}
                  />
                  <span className="brand-back-label">{SPECIAL_LABEL[view]}</span>
                </button>
              ) : (
                <>
                  <img
                    src="/logo_squash.jpeg"
                    alt="Squash de l'Yvette"
                    className="logo-mark"
                    width={46}
                    height={46}
                  />
                  <span className="brand-title" aria-hidden="true">
                    Squash de l'Yvette
                  </span>
                </>
              )}
            </h1>
          </div>
          <div className="actions">
            {delegation && incomingDelegations.length > 0 && (
              <select
                className="acting-as-select"
                value={actingAsId ?? ""}
                onChange={(e) => setActingAsId(e.target.value || null)}
                aria-label="Réserver pour"
                title="Réserver pour"
              >
                <option value="">Pour moi</option>
                {incomingDelegations.map((d) => (
                  <option key={d.delegatorId} value={d.delegatorId}>
                    Pour {d.delegatorName}
                  </option>
                ))}
              </select>
            )}
            {/* La cloche s'affiche pour TOUT membre connecté, et non plus seulement quand le
                push est disponible : son journal est justement ce qui reste quand le push ne
                fonctionne pas. La pastille compte les notifications non lues — la liste
                d'attente, elle, se lit à l'intérieur. */}
            <button
              className="secondary icon-btn alerts-btn"
              onClick={() => {
                setAlertsOpen(true);
                if (unread > 0) {
                  setUnread(0);
                  setNotifs((prev) => prev.map((n) => ({ ...n, read: true })));
                  fetch("/api/notifications", { method: "POST" }).catch(() => {});
                }
              }}
              aria-label={`Notifications et liste d'attente${unread ? ` (${unread} non lue${unread > 1 ? "s" : ""})` : ""}`}
              title="Notifications et liste d'attente"
            >
              <BellIcon />
              {/* Plafonné à « 9+ » : au-delà, le chiffre exact n'apprend plus rien et sa
                  largeur déforme la pastille. Le serveur compte sur une fenêtre bornée
                  (cf. /api/notifications), le plafond est donc atteint bien avant que ce
                  décompte ne puisse être pris en défaut. */}
              {unread > 0 && <span className="badge">{unread > 9 ? "9+" : unread}</span>}
            </button>
            {/* Réglages : accès DIRECT (hors menu ⋯), comme les notifications. */}
            <SettingsButton
              myId={myId}
              nickname={nickname}
              listed={listed}
              onProfileSaved={checkMe}
              onDelegationsChanged={loadIncomingDelegation}
              toast={toast}
            />
            {/* Menu ⋯ : regroupe les actions secondaires pour dégager le logo. */}
            <HeaderMenu
              items={[
                ...(isAdmin
                  ? [
                      {
                        key: "admin",
                        label: "Admin",
                        icon: <BellIcon />,
                        badge: pendingRequests > 0 ? pendingRequests : undefined,
                        onClick: () => {
                          window.location.href = "/admin";
                        },
                      },
                    ]
                  : []),
                {
                  key: "money",
                  // « Tricount » est une marque tierce ; PRODUCT.md, le code (`view === "money"`)
                  // et les commentaires disent tous « Frais ». On aligne le seul endroit visible.
                  label: "Frais partagés",
                  icon: <EuroIcon />,
                  active: view === "money",
                  badge: tricount && triOwed > 0 ? triOwed : undefined,
                  disabled: !tricount,
                  comingSoon: !tricount,
                  onClick: () => setView(view === "money" ? "day" : "money"),
                },
                {
                  key: "tourney",
                  label: "Tournois",
                  icon: <TrophyIcon />,
                  active: view === "tourney",
                  disabled: !tournament,
                  comingSoon: !tournament,
                  onClick: () => setView(view === "tourney" ? "day" : "tourney"),
                },
                {
                  key: "interclub",
                  label: "Interclub",
                  icon: <TeamsIcon />,
                  active: view === "interclub",
                  disabled: !interclub,
                  comingSoon: !interclub,
                  onClick: () => setView(view === "interclub" ? "day" : "interclub"),
                },
                {
                  key: "directory",
                  label: "Annuaire",
                  icon: <UsersIcon />,
                  disabled: !directory,
                  comingSoon: !directory,
                  onClick: () => setDirectoryOpen(true),
                },
                {
                  key: "share",
                  label: "Partager l'appli",
                  icon: <ShareIcon />,
                  onClick: () => setShareOpen(true),
                },
                {
                  key: "logout",
                  label: "Déconnexion",
                  icon: <LogoutIcon />,
                  onClick: logout,
                },
              ]}
            />
          </div>
        </div>
        {/* Sous-titre pleine largeur : accueil + lieu réunis sur une seule ligne
            (l'ancienne ligne « Bonjour » séparée est supprimée pour gagner de la place). */}
        {/* « Le Complexe, Bures » retiré : ce lieu est invariant et n'a jamais changé de
            session en session. Il appartient à la modale « Confidentialité », pas à la
            ligne 2 de chaque chargement — ~20 px rendus à la grille, qui est le produit. */}
        {!isSpecial && (
          <div className="sub">Bonjour {nickname || me.split(" ")[0]} 👋</div>
        )}
      </header>

      {/* Relance d'enrôlement biométrique (une seule fois, masquable) : gated en interne sur le
          flag `biometry` + le support de l'appareil + l'absence de passkey déjà enrôlé. */}
      <PasskeyEnrollPrompt toast={toast} />

      {/* Modales du menu ⋯ (rendues hors du menu pour survivre à sa fermeture). */}
      <ShareModal open={shareOpen} onClose={() => setShareOpen(false)} toast={toast} />
      <DirectoryModal
        open={directoryOpen}
        onClose={() => setDirectoryOpen(false)}
        toast={toast}
      />

      {delegation &&
        incomingDelegations.map((deleg) => {
          const key = `${deleg.delegatorId}|${deleg.expiresAt}`;
          if (delegBannerDismissed.includes(key)) return null;
          return (
            <div key={key} className="notice info deleg-banner" role="status">
              <span>
                🤝 <strong>{deleg.delegatorName}</strong> t'a délégué ses droits : tu peux
                réserver / annuler en son nom jusqu'au{" "}
                {new Date(deleg.expiresAt).toLocaleString("fr-FR", {
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                . Sélectionne « Pour {deleg.delegatorName} » en haut à droite pour agir en son
                nom.
              </span>
              <button
                type="button"
                className="deleg-banner-close"
                aria-label="Masquer ce message"
                onClick={() => setDelegBannerDismissed((prev) => [...prev, key])}
              >
                ✕
              </button>
            </div>
          );
        })}

      {!canBookNow && (
        <div className="notice info readonly-note">
          🔒 <strong>Lecture seule</strong> (connexion par email) : réserver un terrain passe par
          ResaMania. Tu peux consulter le planning et te mettre « +1 » sur un créneau déjà réservé
          par un membre.
        </div>
      )}

      {/* Navigation de date : flèches + libellé (qui ouvre le calendrier natif) + pastille
          « Aujourd'hui » (toujours présente, inactive si on y est déjà), le tout sur UNE ligne. */}
      {!isSpecial && (
      <div className="toolbar">
        {/* Le libellé DOIT suivre la vue : le handler recule de 7 jours en vue semaine.
            Annoncer « jour précédent » et reculer d'une semaine trompe qui n'a que l'audio. */}
        <button className="secondary nav" aria-label={view === "week" ? "Semaine précédente" : "Jour précédent"} onClick={() => setDate(addDays(date, view === "week" ? -7 : -1))}>←</button>
        <button
          type="button"
          className="secondary datebtn"
          onClick={openDatePicker}
          title="Choisir une date"
          aria-label="Choisir une date"
        >
          <CalendarIcon />
          <span className="date">
            {view === "week" ? (
              weekLabel(date)
            ) : (
              <>
                {relativeDay(date) && (
                  <strong className="date-rel">{relativeDay(date)} · </strong>
                )}
                {shortPretty(date)}
              </>
            )}
          </span>
        </button>
        <button className="secondary nav" aria-label={view === "week" ? "Semaine suivante" : "Jour suivant"} onClick={() => setDate(addDays(date, view === "week" ? 7 : 1))}>→</button>
        {/* TOUJOURS rendu, grisé quand on est déjà sur aujourd'hui. Sa place dans la barre
            doit être FIXE : le masquer faisait sauter les flèches ← → d'un cran dès qu'on
            revenait sur aujourd'hui, donc sous le doigt entre deux navigations de jour.
            Une cible qui se déplace pendant qu'on l'utilise coûte plus cher que le contrôle
            inerte qu'on économise. */}
        <button
          type="button"
          className="secondary today-chip"
          onClick={() => setDate(today)}
          disabled={date === today}
          aria-label="Revenir à aujourd'hui"
          title={date === today ? "Tu es déjà sur aujourd'hui" : "Revenir à aujourd'hui"}
        >
          Auj.
        </button>
        {/* Champ natif masqué : ouvert via showPicker() au clic sur le libellé de date. */}
        <input
          ref={dateInputRef}
          type="date"
          className="datepick-hidden"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          tabIndex={-1}
          aria-hidden="true"
        />
      </div>
      )}

      {/* Vue (Jour/Semaine) à gauche ; à droite les actions compactes en icônes :
          sélection multiple, légende (ⓘ) et rafraîchir.
          La barre entière ne s'affiche QUE sur le planning. Elle restait montée dans les
          modules faute d'autre sortie ; le retour vit maintenant dans l'en-tête, et
          « Jour / Semaine » redevient ce qu'il est — un choix de vue du planning, qui n'avait
          rien à faire au-dessus d'une liste de rencontres ou d'un tableau de frais. */}
      {!isSpecial && (
      <div className="viewbar">
        <div className="viewtabs" role="group" aria-label="Vue">
          <button className={view === "day" ? "active" : ""} aria-pressed={view === "day"} onClick={() => setView("day")}>Jour</button>
          <button className={view === "week" ? "active" : ""} aria-pressed={view === "week"} onClick={() => setView("week")}>Semaine</button>
        </div>
        <div className="viewbar-icons">
          <button
            type="button"
            className={"secondary icon-btn selbtn" + (selMode ? " active" : "")}
            aria-pressed={selMode}
            onClick={() => setSelMode((v) => !v)}
            title={selMode ? "Annuler la sélection" : "Réserver plusieurs créneaux"}
            aria-label={selMode ? "Annuler la sélection multiple" : "Réserver plusieurs créneaux"}
          >
            <MultiSelectIcon />
          </button>
          <LegendInfo />
          {/* `() => reload(true)` et non `reload` : passer le handler directement lui
              transmettrait l'événement de clic comme argument. Et un rafraîchissement
              DEMANDÉ doit de toute façon ignorer le cache — c'est tout son objet. */}
          <button
            className={"secondary icon-btn refresh" + (loading ? " spin" : "")}
            onClick={() => reload(true)}
            disabled={loading}
            aria-label="Rafraîchir"
            title="Rafraîchir"
          >
            <RefreshIcon />
          </button>
        </div>
      </div>
      )}

      {!isSpecial && (
      <div className="filters" role="group" aria-label="Plage horaire">
        {RANGES.map((r) => (
          <button
            key={r.key}
            className={range === r.key ? "active" : ""}
            aria-pressed={range === r.key}
            onClick={() => setRange(r.key)}
          >
            {r.label}
          </button>
        ))}
      </div>
      )}

      {view === "day" && planning?.cached && (
        <p className="muted tiny cache-note">
          🕒{" "}
          {planning.notice
            ? planning.notice
            : `Planning en cache — dernière mise à jour ${
                planning.cachedAt
                  ? new Date(planning.cachedAt).toLocaleString("fr-FR", {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "—"
              } par un membre connecté à ResaMania.`}
        </p>
      )}

      {/* Cible du lien d'évitement : saute l'en-tête et la barre de navigation. Porte un
          titre `sr-only` — un <div> vide et sans nom ne fait rien annoncer au lecteur
          d'écran, qui ne sait donc pas si le saut a fonctionné. */}
      <div id="main-content" tabIndex={-1}>
        <h2 className="sr-only">Planning des terrains</h2>
      </div>

      {/* Annonce discrète pour lecteurs d'écran (chargement / erreur). */}
      <p className="sr-only" role="status" aria-live="polite">
        {loading ? "Chargement du planning…" : error ? `Erreur : ${error}` : ""}
      </p>

      {/* Région DISTINCTE pour l'action en cours (réserver / annuler). Séparée de celle du
          chargement : sans ça, l'annonce « Réservation en cours » se met en file derrière
          « Chargement du planning » et arrive après coup — voire jamais. */}
      <p className="sr-only" role="status" aria-live="polite">
        {busyVerb}
        {progress ? ` ${progress.done} sur ${progress.total}` : ""}
      </p>

      {error && !isSpecial && <div className="notice error" role="alert">⚠️ {error}</div>}

      {tricount && view === "money" && (
        <Tricount toast={toast} onExpired={handleExpired} onOwedChange={setTriOwed} />
      )}

      {tournament && view === "tourney" && (
        <Tournament toast={toast} onExpired={handleExpired} />
      )}

      {interclub && view === "interclub" && (
        <Interclub toast={toast} onExpired={handleExpired} />
      )}

      {isSpecial
        ? null
        : view === "day"
        ? planning
          ? (() => {
              const slots = planning.slots.filter((s) => inRange(s.startsAt, range));
              if (slots.length === 0) {
                return <EmptyState icon="🎾" text="Aucun créneau sur cette plage horaire." />;
              }
              return (
                <PlanningGrid
                  planning={{ ...planning, slots }}
                  onBook={onBook}
                  onCancelMine={onCancelMine}
                  onTogglePresence={onTogglePresence}
                  onBookMany={onBookMany}
                  selMode={selMode}
                  setSelMode={setSelMode}
                  onWatch={onWatch}
                  onUnwatch={onUnwatch}
                  canWatch={canNotify}
                  waitCountFor={waitCountFor}
                  myWaitFor={myWaitFor}
                  pendingIds={pendingIds}
                  progress={progress}
                  retryIds={failedSel}
                />
              );
            })()
          : loading
            ? <Skeleton />
            : null
        : week.length
          ? <WeekGrid days={week} filter={(iso) => inRange(iso, range)} onPick={pickDay} onBook={onBook} onCancelMine={onCancelMine} onTogglePresence={onTogglePresenceWeek} onBookMany={onBookMany} selMode={selMode} setSelMode={setSelMode} onWatch={onWatch} onUnwatch={onUnwatch} canWatch={canNotify} waitCountFor={waitCountFor} myWaitFor={myWaitFor} pendingIds={pendingIds} progress={progress} />
          : loading
            ? <Skeleton />
            : null}

      {view === "day" && (
        <section className="journal">
          <h2>👥 Réservations des membres de l'asso — {prettyDate(date)}</h2>
          {journal.length === 0 ? (
            <EmptyState icon="👥" text="Aucun membre de l'asso n'a (encore) réservé ce jour-là." />
          ) : (
            <ul>
              {journal.map((b) => {
                // Actions visibles sur MA résa, ou sur celle d'un délégant que je peux gérer.
                const canManage = b.mine || !!b.manageableOnBehalfOf;
                return (
                <li key={b.id} className={b.mine ? "mine" : ""}>
                  <span>
                    <strong>{fmtTime(b.startsAt)}</strong> · {b.courtName} ·{" "}
                    {b.displayName} {b.mine && "(toi)"}
                    {!b.mine && b.manageableOnBehalfOf && (
                      <span className="muted tiny"> · via délégation</span>
                    )}
                    {/* Résa faite hors appli : on le DIT plutôt que de laisser croire que
                        tout le journal vient de l'appli. Rien d'affiché pour "app", qui
                        reste le cas normal (et le seul connu avant cette fonction). */}
                    {b.source === "resamania" && (
                      <span className="muted tiny" title="Réservation faite directement sur ResaMania, hors de l'appli">
                        {" "}· sur ResaMania
                      </span>
                    )}
                  </span>
                  {canManage && (
                    <span className="jrow-actions">
                      <button
                        type="button"
                        className="ics"
                        title="Ajouter à mon agenda (.ics, rappel 1 h avant)"
                        aria-label="Ajouter à mon agenda"
                        onClick={() => downloadIcs(b)}
                      >
                        📅
                      </button>
                      <button className="cancel" onClick={() => onCancel(b)}>
                        Annuler
                      </button>
                    </span>
                  )}
                </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <PrivacyNotice />
      {alertsOpen && (
        <Dialog onClose={() => setAlertsOpen(false)} label="Notifications et liste d'attente">
            <h3>🔔 Notifications</h3>
            {notifs.length === 0 ? (
              <p className="muted tiny">Aucune notification pour le moment.</p>
            ) : (
              <>
              <div className="notif-actions">
                <span className="muted tiny">
                  Effacées automatiquement au bout de {NOTIFICATION_RETENTION_DAYS} jours.
                </span>
                {confirmWipe ? (
                  <>
                    <button className="secondary tiny" onClick={() => setConfirmWipe(false)}>
                      Annuler
                    </button>
                    <button
                      className="danger tiny"
                      onClick={async () => {
                        setConfirmWipe(false);
                        setNotifs([]);
                        setUnread(0);
                        await fetch("/api/notifications", { method: "DELETE" }).catch(() => {});
                      }}
                    >
                      Tout effacer
                    </button>
                  </>
                ) : (
                  <button className="secondary tiny" onClick={() => setConfirmWipe(true)}>
                    Vider
                  </button>
                )}
              </div>
              <ul className="notif-list">
                {notifs.map((n) => {
                  const inner = (
                    <>
                      <span className="notif-title">
                        {n.title}
                        {/* Une série repliée dit combien elle représente, sinon « 1 ligne pour
                            toute une soirée » se lirait comme une notification manquante. */}
                        {n.count > 1 && (
                          <span className="notif-count" title={`${n.count} notifications`}>
                            ×{n.count}
                          </span>
                        )}
                      </span>
                      <span className="notif-body">{n.body}</span>
                      <span className="notif-at">{stampFR(n.at)}</span>
                    </>
                  );
                  // `url` était renvoyé par l'API et stocké depuis toujours — le schéma le
                  // décrit comme « où mène le clic » — mais la cloche n'en faisait rien : le
                  // clic ne menait nulle part. Les liens sont INTERNES (poser une notification
                  // vers l'extérieur n'a jamais été prévu), d'où `<Link>`.
                  return (
                    <li key={n.id} className={n.read ? undefined : "is-unread"}>
                      {n.url ? (
                        <Link
                          href={n.url}
                          className="notif-link"
                          onClick={() => setAlertsOpen(false)}
                        >
                          {inner}
                        </Link>
                      ) : (
                        inner
                      )}
                    </li>
                  );
                })}
              </ul>
              </>
            )}

            <h3>🕒 Ma liste d'attente</h3>
            {alerts.length === 0 ? (
              <p className="muted">
                Tu n'es sur aucune liste d'attente. Sur un créneau complet, touche
                l'horaire (vue Jour) ou la case (vue Semaine) pour être prévenu qu'un
                terrain se libère.
              </p>
            ) : (
              <ul className="alerts-list">
                {alerts.map((a) => (
                  <li key={a.id}>
                    <span>
                      {prettyDate(a.date)} · <strong>{a.hm}</strong>
                      {a.count != null && a.position != null && (
                        <span className="muted tiny">
                          {" "}
                          — {a.position}
                          <sup>e</sup> sur {a.count} en attente
                        </span>
                      )}
                    </span>
                    <button className="cancel" onClick={() => cancelAlert(a.id)}>
                      Retirer
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="modal-actions">
              <button className="secondary" onClick={() => setAlertsOpen(false)}>
                Fermer
              </button>
            </div>
        </Dialog>
      )}

      <Toasts items={toasts} />
      <ConfirmDialog state={confirmState} onResolve={resolveConfirm} />
    </main>
  );
}
