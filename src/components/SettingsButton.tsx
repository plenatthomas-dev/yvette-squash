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
import { enrollPasskey, passkeySupported } from "@/lib/webauthnClient";

type PasskeyInfo = { id: string; deviceLabel: string | null; createdAt: string; lastUsedAt: string | null };

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
          i
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
  emailOnly,
  onProfileSaved,
  onDelegationsChanged,
  toast,
}: {
  myId: string | null;
  nickname: string | null;
  listed: boolean;
  /** Compte « email seul » (sans ResaMania) : seul cas où la connexion biométrique est proposée. */
  emailOnly: boolean;
  onProfileSaved: () => void;
  /** Une délégation REÇUE a changé : l'appelant doit relire les siennes (sélecteur « Pour X »). */
  onDelegationsChanged: () => void;
  toast: (type: "ok" | "err" | "info", msg: string) => void;
}) {
  const { directory, delegation, emailLogin } = useFeatures();
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>("system");
  const [nick, setNick] = useState(nickname ?? "");
  const [saving, setSaving] = useState(false);
  // État optimiste de la case « annuaire » : bascule tout de suite, se resync sur `listed`.
  const [listedLocal, setListedLocal] = useState(listed);
  const [savingListed, setSavingListed] = useState(false);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  // Doit rester synchronisé avec MAX_LEN côté serveur (api/feedback/route.ts).
  const COMMENT_MAX = 1000;

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

  // Connexion biométrique (passkeys) — comptes « email seul » uniquement.
  const showPasskeys = emailOnly && emailLogin;
  const [pkSupported, setPkSupported] = useState(false);
  const [passkeys, setPasskeys] = useState<PasskeyInfo[] | null>(null);
  const [pkBusy, setPkBusy] = useState(false);

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
      toast("ok", "Connexion biométrique activée sur cet appareil.");
      loadPasskeys();
    } else {
      toast("err", r.error ?? "Activation impossible.");
    }
  };

  const removePasskey = async (id: string) => {
    setPkBusy(true);
    try {
      const res = await fetch(`/api/auth/webauthn/passkeys/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Erreur ${res.status}`);
      setPasskeys((prev) => (prev ?? []).filter((p) => p.id !== id));
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

  const toggleDelegate = (id: string, on: boolean) =>
    setPickedDelegates((prev) => (on ? [...prev, id] : prev.filter((x) => x !== id)));

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
    if (ok) setPickedDelegates([]);
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
  }, []);

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
            <h3>Paramètres</h3>

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
                  durée limitée (ex. ils gèrent les résas d'une soirée à ta place pendant que
                  tu es indisponible). La réservation reste sous ton compte ResaMania ; on
                  trace qui a agi.
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
                {delegateMembers === null ? (
                  <p className="muted tiny">Chargement…</p>
                ) : availableDelegates.length === 0 ? (
                  outgoingDelegations.length === 0 ? (
                    <p className="muted tiny">Aucun autre membre disponible pour l'instant.</p>
                  ) : null
                ) : (
                  <div className="delegation-form">
                    <div
                      className="delegate-picklist"
                      role="group"
                      aria-label="Choisir un ou plusieurs délégués"
                    >
                      {availableDelegates.map((m) => (
                        <label key={m.id} className="check-row">
                          <input
                            type="checkbox"
                            checked={pickedDelegates.includes(m.id)}
                            onChange={(e) => toggleDelegate(m.id, e.target.checked)}
                          />
                          <span>{m.name}</span>
                        </label>
                      ))}
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
              </section>
            )}

            {showPasskeys && (
              <section className="setting">
                <SettingInfo title="Connexion biométrique">
                  Active Face ID / Touch ID / empreinte pour te reconnecter sans mot de passe
                  sur cet appareil. Ta biométrie ne quitte jamais ton téléphone : l'appli ne
                  reçoit qu'une clé de sécurité, pas ton empreinte.
                </SettingInfo>
                {passkeys === null ? (
                  <p className="muted tiny">Chargement…</p>
                ) : (
                  passkeys.length > 0 && (
                    <ul className="passkey-list">
                      {passkeys.map((p) => (
                        <li key={p.id} className="passkey-item">
                          <span className="tiny">
                            🔐 {p.deviceLabel || "Cet appareil"}
                            <span className="muted">
                              {" · ajouté le "}
                              {new Date(p.createdAt).toLocaleDateString("fr-FR", {
                                day: "numeric",
                                month: "short",
                              })}
                            </span>
                          </span>
                          <button
                            className="secondary"
                            onClick={() => removePasskey(p.id)}
                            disabled={pkBusy}
                            title="Retirer ce passkey"
                          >
                            Retirer
                          </button>
                        </li>
                      ))}
                    </ul>
                  )
                )}
                {pkSupported ? (
                  <button onClick={addPasskey} disabled={pkBusy}>
                    {pkBusy ? "…" : "Activer sur cet appareil"}
                  </button>
                ) : (
                  <p className="muted tiny">
                    Cet appareil ne propose pas de connexion biométrique (essaie depuis ton
                    téléphone).
                  </p>
                )}
              </section>
            )}

            <section className="setting">
              <h4>Un commentaire ?</h4>
              <p className="muted tiny">
                Une question, une idée, un bug ? Écris-le ici, ça m'est envoyé par e-mail.
              </p>
              <textarea
                className="comment-field"
                value={comment}
                maxLength={COMMENT_MAX}
                rows={3}
                placeholder="Ton message…"
                onChange={(e) => setComment(e.target.value)}
              />
              <div
                className="muted tiny"
                style={{ textAlign: "right" }}
                aria-live="polite"
              >
                {comment.length} / {COMMENT_MAX}
              </div>
              <button onClick={sendComment} disabled={sending || !comment.trim()}>
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
