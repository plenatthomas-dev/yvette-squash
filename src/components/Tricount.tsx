"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  MAX_COMMENT_LEN,
  MAX_PARTS,
  splitEqually,
  splitByWeights,
} from "@/lib/tricount";
import { Dialog } from "@/components/Dialog";
import { playPaymentJingle } from "@/lib/sound";

// Vue « Frais » : tricounts par jour (un tricount = les dépenses d'une date),
// avec historique, validation des payeurs puis remboursements guidés.
// Montants en centimes partout ; euros seulement à l'affichage.

interface Member {
  id: string;
  name: string; // prénom + nom réels — le Tricount n'utilise JAMAIS le pseudo
  fullName: string; // idem (conservé pour compat) : prénom + nom réels
}
interface ExpenseItem {
  id: string;
  label: string;
  amountCents: number;
  isRefund: boolean;
  spentAt: string;
  payerId: string;
  payerName: string;
  participantIds: string[];
  participantNames: string[];
  canDelete: boolean;
  canEdit: boolean;
}
interface PayerStatus {
  id: string;
  name: string;
  approved: boolean;
}
interface BalanceItem {
  userId: string;
  name: string;
  cents: number;
}
interface TransferItem {
  fromId: string;
  toId: string;
  amountCents: number;
  fromName: string;
  toName: string;
}
interface CommentItem {
  id: string;
  body: string;
  userId: string;
  userName: string;
  createdAt: string;
  canDelete: boolean;
}
interface TricountItem {
  id: string;
  date: string;
  title: string | null;
  totalCents: number;
  ready: boolean; // tous les payeurs ont validé -> remboursements ouverts
  settled: boolean; // tout le monde est à zéro
  payers: PayerStatus[];
  expenses: ExpenseItem[];
  balances: BalanceItem[];
  transfers: TransferItem[];
  comments: CommentItem[];
}
interface TricountData {
  me: string;
  // Compte « email seul » : gestion des dépenses masquée (le serveur refuse aussi).
  emailOnly: boolean;
  // Reste-t-il des tricounts plus anciens au-delà de la fenêtre demandée ?
  hasMore: boolean;
  members: Member[];
  tricounts: TricountItem[];
}

// Nombre de tricounts chargés au départ, et pas d'agrandissement de « Charger plus ».
const TRICOUNT_PAGE = 25;

/** 1234 -> "12,34 €" (format français, toujours 2 décimales). */
export function fmtEuros(cents: number): string {
  return (
    (cents / 100).toLocaleString("fr-FR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + " €"
  );
}

/** "12,34" / "12.34" / "12" -> centimes (entier), ou null si invalide. */
export function parseEuros(input: string): number | null {
  const s = input.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}

// Format court pour tenir dans l'en-tête de carte : « mer. 8 juil. » (au lieu de
// « mercredi 8 juillet », qui débordait sur mobile).
function prettyDate(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("fr-FR", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

// Nom compact pour la liste « Pour qui ? » (mode parts) : « Prénom Nom » → « P. Nom »,
// pour laisser le montant en € tenir dans la modale sur mobile.
function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts[0][0].toUpperCase()}. ${parts.slice(1).join(" ")}`;
}

// L'asso vit à l'heure de Paris : on fige l'affichage des horodatages sur ce fuseau plutôt
// que sur celui de l'appareil, pour qu'un membre en déplacement (autre fuseau) voie l'heure
// « du club » et non une heure décalée.
const CLUB_TZ = "Europe/Paris";

/** Horodatage précis d'un remboursement : "03/07/2026 à 21:15". */
function fmtStamp(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleDateString("fr-FR", { timeZone: CLUB_TZ }) +
    " à " +
    d.toLocaleTimeString("fr-FR", { timeZone: CLUB_TZ, hour: "2-digit", minute: "2-digit" })
  );
}

function todayISO(): string {
  // Jour « du club » (Europe/Paris), indépendant du fuseau de l'appareil du membre.
  return new Date().toLocaleDateString("en-CA", { timeZone: CLUB_TZ });
}

/** Horodatage compact d'un commentaire : "3 juil. · 21:15". */
function fmtCommentStamp(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleDateString("fr-FR", { timeZone: CLUB_TZ, day: "numeric", month: "short" }) +
    " · " +
    d.toLocaleTimeString("fr-FR", { timeZone: CLUB_TZ, hour: "2-digit", minute: "2-digit" })
  );
}

interface Props {
  toast: (type: "ok" | "err" | "info", msg: string) => void;
  onExpired: (status: number) => boolean;
  // Remonte le nombre de tricounts où JE dois de l'argent avec remboursements ouverts
  // (alimente le badge € de la barre d'actions). Optionnel.
  onOwedChange?: (count: number) => void;
}

export default function Tricount({ toast, onExpired, onOwedChange }: Props) {
  const [data, setData] = useState<TricountData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // Tricount déplié (au plus un ; "" = tous repliés, null = pas encore initialisé)
  const [openId, setOpenId] = useState<string | null>(null);
  // Pagination : combien de tricounts on demande (agrandi par « Charger plus »).
  const [limit, setLimit] = useState(TRICOUNT_PAGE);

  // Formulaire « nouvelle dépense » (réutilisé en édition : editingId non nul).
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Tricount cible : soit la date d'un tricount existant, soit "new" (nouvelle date).
  const [tcChoice, setTcChoice] = useState<string>("new");
  const [date, setDate] = useState(todayISO());
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [payerId, setPayerId] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Répartition : « equal » = à parts égales ; « shares » = pondérée (nb de parts/pers.).
  const [splitMode, setSplitMode] = useState<"equal" | "shares">("equal");
  const [weights, setWeights] = useState<Record<string, number>>({});

  // Formulaire « j'ai remboursé » (rattaché à UN tricount prêt ; le rembourseur
  // est TOUJOURS l'utilisateur connecté)
  const [refundFor, setRefundFor] = useState<TricountItem | null>(null);
  const [refundTo, setRefundTo] = useState("");
  const [refundAmount, setRefundAmount] = useState("");

  const [confirmDelete, setConfirmDelete] = useState<ExpenseItem | null>(null);
  // Brouillons du fil de commentaires (idée 5a), un par tricount déplié.
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/tricount?limit=${limit}`);
      if (onExpired(r.status)) return;
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `Erreur ${r.status}`);
      setData(j as TricountData);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [onExpired, limit]);

  useEffect(() => {
    load();
  }, [load]);

  // Le premier tricount non soldé est déplié au premier chargement UNIQUEMENT :
  // ensuite on peut tout replier (openId = ""), rien ne se rouvre tout seul.
  useEffect(() => {
    if (data && openId === null) {
      const first = data.tricounts.find((t) => !t.settled) ?? data.tricounts[0];
      setOpenId(first ? first.id : "");
    }
  }, [data, openId]);

  const openExpense = () => {
    if (!data) return;
    const today = todayISO();
    setDate(today);
    // Pré-sélection : le tricount d'aujourd'hui s'il existe, sinon le plus récent,
    // sinon seulement « nouvelle date » (aucun tricount encore).
    const todayTc = data.tricounts.find((t) => t.date === today);
    setTcChoice(todayTc?.date ?? data.tricounts[0]?.date ?? "new");
    setLabel("");
    setAmount("");
    setPayerId(data.me);
    setSelected(new Set(data.members.map((m) => m.id)));
    setSplitMode("equal");
    setWeights(Object.fromEntries(data.members.map((m) => [m.id, 1])));
    setEditingId(null);
    setExpenseOpen(true);
  };

  // Édition d'une dépense existante : on rouvre la MÊME modale, préremplie. Le jour
  // (donc le tricount) est figé. Les parts d'origine ne sont pas stockées (seuls les
  // montants le sont) : on repart en mode « équitable », l'utilisateur repasse en
  // « par parts » s'il le souhaite.
  const openEditExpense = (t: TricountItem, e: ExpenseItem) => {
    if (!data) return;
    setDate(t.date);
    setTcChoice(t.date);
    setLabel(e.label);
    setAmount((e.amountCents / 100).toFixed(2).replace(".", ","));
    setPayerId(e.payerId);
    setSelected(new Set(e.participantIds));
    setSplitMode("equal");
    setWeights(Object.fromEntries(data.members.map((m) => [m.id, 1])));
    setEditingId(e.id);
    setExpenseOpen(true);
  };

  const closeExpense = () => {
    setExpenseOpen(false);
    setEditingId(null);
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Ajuste le nombre de parts d'un participant (boutons +/−), borné à [1, MAX_PARTS].
  const adjustPart = (id: string, delta: number) =>
    setWeights((prev) => ({
      ...prev,
      [id]: Math.max(1, Math.min(MAX_PARTS, (prev[id] ?? 1) + delta)),
    }));

  const submitExpense = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !data) return;
    const cents = parseEuros(amount);
    if (cents === null || cents === 0) {
      toast("err", "Montant invalide — ex. 12,50");
      return;
    }
    if (!label.trim()) {
      toast("err", "Donne un libellé à la dépense.");
      return;
    }
    if (selected.size === 0) {
      toast("err", "Choisis au moins un participant.");
      return;
    }
    // Date cible : celle du tricount existant choisi, ou la nouvelle date saisie.
    const targetDate = tcChoice === "new" ? date : tcChoice;
    const participantIds = [...selected];
    // En mode « parts », on transmet le poids de chaque participant coché ; le serveur
    // fait la répartition pondérée. En mode « équitable », rien (partage égal côté serveur).
    const weightsPayload =
      splitMode === "shares"
        ? Object.fromEntries(participantIds.map((id) => [id, weights[id] ?? 1]))
        : undefined;
    setBusy(true);
    try {
      // Édition : PATCH sur la ligne (le jour/tricount ne bouge pas). Création : POST.
      const res = editingId
        ? await fetch(`/api/tricount/expenses/${editingId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              label: label.trim(),
              amountCents: cents,
              payerId,
              participantIds,
              ...(weightsPayload ? { weights: weightsPayload } : {}),
            }),
          })
        : await fetch("/api/tricount/expenses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              date: targetDate,
              label: label.trim(),
              amountCents: cents,
              payerId,
              participantIds,
              ...(weightsPayload ? { weights: weightsPayload } : {}),
            }),
          });
      if (onExpired(res.status)) return;
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `Erreur ${res.status}`);
      toast("ok", editingId ? "Dépense modifiée" : "Dépense enregistrée");
      closeExpense();
      load();
    } catch (e) {
      toast("err", "Enregistrement impossible : " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const approve = async (t: TricountItem) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/tricount/${t.id}/approve`, { method: "POST" });
      if (onExpired(res.status)) return;
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `Erreur ${res.status}`);
      toast("ok", "Validation enregistrée ✅");
      load();
    } catch (e) {
      toast("err", "Validation impossible : " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Bénéficiaires possibles : MES créanciers dans CE tricount (issus des
  // virements suggérés), avec le montant conseillé.
  const refundOptions = useMemo(() => {
    if (!refundFor || !data) return [];
    return refundFor.transfers.filter((t) => t.fromId === data.me);
  }, [refundFor, data]);

  const openRefund = (t: TricountItem) => {
    if (!data) return;
    const first = t.transfers.find((tr) => tr.fromId === data.me);
    setRefundTo(first?.toId ?? "");
    setRefundAmount(first ? (first.amountCents / 100).toFixed(2).replace(".", ",") : "");
    setRefundFor(t);
  };

  const pickRefundTo = (to: string) => {
    setRefundTo(to);
    const tr = refundOptions.find((o) => o.toId === to);
    if (tr) setRefundAmount((tr.amountCents / 100).toFixed(2).replace(".", ","));
  };

  const submitRefund = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !refundFor) return;
    const cents = parseEuros(refundAmount);
    if (cents === null || cents === 0) {
      toast("err", "Montant invalide — ex. 12,50");
      return;
    }
    if (!refundTo) {
      toast("err", "Choisis à qui tu as remboursé.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/tricount/${refundFor.id}/refunds`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toId: refundTo, amountCents: cents }),
      });
      if (onExpired(res.status)) return;
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `Erreur ${res.status}`);
      toast("ok", "Remboursement enregistré 💸");
      playPaymentJingle(); // son « cha-ching » quand on déclare avoir remboursé
      setRefundFor(null);
      load();
    } catch (e) {
      toast("err", "Remboursement impossible : " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    const exp = confirmDelete;
    setConfirmDelete(null);
    if (!exp || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/tricount/expenses/${exp.id}`, { method: "DELETE" });
      if (onExpired(res.status)) return;
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Erreur ${res.status}`);
      }
      toast("ok", "Ligne supprimée");
      load();
    } catch (e) {
      toast("err", "Suppression impossible : " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Fil de commentaires (idée 5a) : poster / supprimer un message.
  const postComment = async (t: TricountItem) => {
    if (busy) return;
    const text = (commentDrafts[t.id] ?? "").trim();
    if (!text) return;
    if (text.length > MAX_COMMENT_LEN) {
      toast("err", `Message trop long (${MAX_COMMENT_LEN} caractères max)`);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/tricount/${t.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text }),
      });
      if (onExpired(res.status)) return;
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `Erreur ${res.status}`);
      setCommentDrafts((d) => ({ ...d, [t.id]: "" }));
      load();
    } catch (e) {
      toast("err", "Message impossible : " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const deleteComment = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/tricount/comments/${id}`, { method: "DELETE" });
      if (onExpired(res.status)) return;
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Erreur ${res.status}`);
      }
      load();
    } catch (e) {
      toast("err", "Suppression impossible : " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Mon solde global = somme de mes soldes sur tous les tricounts non soldés.
  const myGlobal = useMemo(() => {
    if (!data) return 0;
    return data.tricounts.reduce(
      (s, t) => s + (t.balances.find((b) => b.userId === data.me)?.cents ?? 0),
      0,
    );
  }, [data]);

  // Remonte le compteur du badge € : tricounts où je dois de l'argent, remboursements
  // ouverts. Recalculé à chaque (re)chargement → le badge suit mes remboursements en direct.
  useEffect(() => {
    if (!data || !onOwedChange) return;
    const n = data.tricounts.filter(
      (t) =>
        t.ready &&
        !t.settled &&
        (t.balances.find((b) => b.userId === data.me)?.cents ?? 0) < 0,
    ).length;
    onOwedChange(n);
  }, [data, onOwedChange]);

  // Répartition affichée en direct dans le formulaire : montant dû par chaque participant
  // coché, recalculé à chaque frappe (montant, sélection, mode, parts). Purement indicatif —
  // le serveur reste la source de vérité au moment de l'enregistrement.
  const shareByMember = useMemo(() => {
    const map = new Map<string, number>();
    const previewCents = parseEuros(amount);
    if (previewCents === null || previewCents === 0 || !data) return map;
    const selectedIds = data.members.filter((m) => selected.has(m.id)).map((m) => m.id);
    if (selectedIds.length === 0) return map;
    const parts =
      splitMode === "shares"
        ? splitByWeights(previewCents, selectedIds, selectedIds.map((id) => weights[id] ?? 1))
        : splitEqually(previewCents, selectedIds.length);
    selectedIds.forEach((id, i) => map.set(id, parts[i]));
    return map;
  }, [amount, splitMode, weights, data, selected]);

  if (loading && !data) return <p className="muted">Chargement des frais…</p>;
  if (error) return <div className="notice error" role="alert">⚠️ {error}</div>;
  if (!data) return null;

  return (
    <section className="tricount">
      <div className="tri-summary">
        <p className={"tri-me " + (myGlobal > 0 ? "pos" : myGlobal < 0 ? "neg" : "")}>
          {myGlobal > 0
            ? `On te doit ${fmtEuros(myGlobal)} au total`
            : myGlobal < 0
              ? `Tu dois ${fmtEuros(-myGlobal)} au total`
              : "Tu es à l'équilibre 👌"}
        </p>
      </div>

      {/* Comptes email-seul : pas de gestion de dépenses (mais remboursements,
          messagerie et validation restent accessibles plus bas). */}
      {!data.emailOnly && (
        <div className="tri-actions">
          <button onClick={openExpense} disabled={busy}>
            ➕ Nouvelle dépense
          </button>
        </div>
      )}

      {data.tricounts.length === 0 && (
        <p className="muted">
          Aucun tricount pour le moment. Ajoute une dépense (repas, balles, pot…) :
          un tricount se crée automatiquement pour ce jour-là.
        </p>
      )}

      {/* Historique : un tricount par jour, le plus récent d'abord */}
      {data.tricounts.map((t) => {
        const open = openId === t.id;
        const myBal = t.balances.find((b) => b.userId === data.me)?.cents ?? 0;
        const iAmPayer = t.payers.find((p) => p.id === data.me);
        const pending = t.payers.filter((p) => !p.approved);
        return (
          <article key={t.id} className={"tri-card" + (t.settled ? " settled" : "")}>
            <header
              className="tri-card-head"
              role="button"
              tabIndex={0}
              aria-expanded={open}
              onClick={() => setOpenId(open ? "" : t.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpenId(open ? "" : t.id);
                }
              }}
            >
              <div className="tri-card-title">
                <strong>Tricount du {prettyDate(t.date)}</strong>
                <small>
                  {fmtEuros(t.totalCents)}
                  {myBal !== 0 &&
                    ` · ${myBal > 0 ? `on te doit ${fmtEuros(myBal)}` : `tu dois ${fmtEuros(-myBal)}`}`}
                </small>
              </div>
              <span
                className={
                  "tri-chip " + (t.settled ? "ok" : t.ready ? "ready" : "pending")
                }
              >
                {t.settled ? "Équilibré ✅" : t.ready ? "Remboursements ouverts" : "En cours"}
              </span>
            </header>

            {open && (
              <div className="tri-card-body">
                <ul className="tri-expenses">
                  {t.expenses.map((e) => (
                    <li key={e.id} className={e.isRefund ? "refund" : ""}>
                      <div className="tri-line">
                        <span className="tri-label">
                          {e.isRefund ? "💸 " : ""}
                          <strong>{e.label}</strong>
                          <small>
                            {e.isRefund
                              ? `${e.payerName} → ${e.participantNames.join(", ")} · le ${fmtStamp(e.spentAt)}`
                              : `${e.payerName} a payé pour ${e.participantNames.length} pers.`}
                          </small>
                        </span>
                        <span className="tri-amount">
                          <strong>{fmtEuros(e.amountCents)}</strong>
                          {e.canEdit && !t.settled && !data.emailOnly && (
                            <button
                              className="secondary tri-edit"
                              onClick={() => openEditExpense(t, e)}
                              disabled={busy}
                              aria-label={`Modifier « ${e.label} »`}
                            >
                              Modifier
                            </button>
                          )}
                          {e.canDelete && !t.settled && !data.emailOnly && (
                            <button
                              className="cancel"
                              onClick={() => setConfirmDelete(e)}
                              disabled={busy}
                              aria-label={`Supprimer « ${e.label} »`}
                            >
                              Suppr.
                            </button>
                          )}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>

                {t.balances.length > 0 && !t.settled && (
                  <>
                    <h3>⚖️ Soldes</h3>
                    <ul className="tri-balances">
                      {t.balances.map((b) => (
                        <li key={b.userId} className={b.userId === data.me ? "mine" : ""}>
                          <span>{b.name}{b.userId === data.me && " (toi)"}</span>
                          <strong className={b.cents > 0 ? "pos" : b.cents < 0 ? "neg" : ""}>
                            {b.cents > 0 ? "+" : ""}
                            {fmtEuros(b.cents)}
                          </strong>
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                {/* Étape 1 : validation des payeurs */}
                {!t.ready && t.payers.length > 0 && (
                  <div className="tri-approvals">
                    <h3>🔒 Avant les remboursements</h3>
                    <p className="muted tiny">
                      Le payeur valide sa demande de remboursement.{" "}
                      {pending.length > 0 &&
                        `En attente de : ${pending.map((p) => p.name).join(", ")}.`}
                    </p>
                    <ul className="tri-payers">
                      {t.payers.map((p) => (
                        <li key={p.id}>
                          {p.approved ? "✅" : "⏳"} {p.name}
                          {p.id === data.me && " (toi)"}
                        </li>
                      ))}
                    </ul>
                    {iAmPayer && !iAmPayer.approved && (
                      <button onClick={() => approve(t)} disabled={busy}>
                        ✅ OK pour lancer les remboursements
                      </button>
                    )}
                  </div>
                )}

                {/* Étape 2 : remboursements */}
                {t.ready && !t.settled && (
                  <div className="tri-settle">
                    <h3>🔁 Pour tout équilibrer</h3>
                    <ul className="tri-transfers">
                      {t.transfers.map((tr, i) => (
                        <li
                          key={i}
                          className={tr.fromId === data.me || tr.toId === data.me ? "mine" : ""}
                        >
                          <span>
                            <strong>{tr.fromName}</strong> rembourse{" "}
                            <strong>{tr.toName}</strong> :
                          </span>
                          <strong>{fmtEuros(tr.amountCents)}</strong>
                        </li>
                      ))}
                    </ul>
                    {t.transfers.some((tr) => tr.fromId === data.me) && (
                      <button className="secondary" onClick={() => openRefund(t)} disabled={busy}>
                        💸 J'ai remboursé
                      </button>
                    )}
                  </div>
                )}

                {t.settled && (
                  <p className="muted tiny">
                    Tout le monde est remboursé — tricount soldé. 🎉
                  </p>
                )}

                {/* Fil de commentaires (idée 5a) */}
                <section className="tri-comments">
                  <h3>💬 Discussion</h3>
                  {t.comments.length > 0 && (
                    <ul className="tri-comment-list">
                      {t.comments.map((c) => (
                        <li key={c.id} className={c.userId === data.me ? "mine" : ""}>
                          <div className="tri-comment-head">
                            <strong>{c.userName}{c.userId === data.me && " (toi)"}</strong>
                            <small>{fmtCommentStamp(c.createdAt)}</small>
                          </div>
                          <p className="tri-comment-body">{c.body}</p>
                          {c.canDelete && (
                            <button
                              type="button"
                              className="cancel tri-comment-del"
                              onClick={() => deleteComment(c.id)}
                              disabled={busy}
                              aria-label="Supprimer mon commentaire"
                            >
                              Suppr.
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  <form
                    className="tri-comment-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      postComment(t);
                    }}
                  >
                    <input
                      type="text"
                      value={commentDrafts[t.id] ?? ""}
                      onChange={(e) =>
                        setCommentDrafts((d) => ({ ...d, [t.id]: e.target.value }))
                      }
                      placeholder="Écrire un message…"
                      maxLength={MAX_COMMENT_LEN}
                      aria-label="Nouveau commentaire"
                    />
                    <button
                      type="submit"
                      disabled={busy || !(commentDrafts[t.id] ?? "").trim()}
                    >
                      Envoyer
                    </button>
                  </form>
                </section>
              </div>
            )}
          </article>
        );
      })}

      {/* Historique paginé : charge les tricounts plus anciens à la demande. */}
      {data.hasMore && (
        <div className="tri-loadmore">
          <button
            className="secondary"
            onClick={() => setLimit((l) => l + TRICOUNT_PAGE)}
            disabled={loading}
          >
            {loading ? "Chargement…" : "Charger l'historique plus ancien"}
          </button>
        </div>
      )}

      {/* Modale « nouvelle dépense » (aussi utilisée pour l'édition) */}
      {expenseOpen && (
        <Dialog
          onClose={() => !busy && closeExpense()}
          closeOnOverlay={!busy}
          className="expense"
          label={editingId ? "Modifier la dépense" : "Nouvelle dépense"}
        >
            <h3>{editingId ? "✏️ Modifier la dépense" : "➕ Nouvelle dépense"}</h3>
            <form onSubmit={submitExpense} className="tri-form">
              {editingId ? (
                // En édition, le jour (donc le tricount) est figé : on l'affiche seulement.
                <p className="muted tiny">Tricount du {prettyDate(date)}</p>
              ) : (
                <>
                  <label className="tri-field">
                    Tricount
                    <select value={tcChoice} onChange={(e) => setTcChoice(e.target.value)}>
                      {data.tricounts.map((t) => (
                        <option key={t.id} value={t.date}>
                          Tricount du {prettyDate(t.date)}
                        </option>
                      ))}
                      <option value="new">➕ Nouvelle date…</option>
                    </select>
                  </label>
                  {tcChoice === "new" && (
                    <label className="tri-field">
                      Jour du tricount
                      <input
                        type="date"
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                      />
                    </label>
                  )}
                </>
              )}
              <input
                type="text"
                placeholder="Libellé (balles, repas, pot…)"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={80}
              />
              <input
                type="text"
                inputMode="decimal"
                placeholder="Montant en € — ex. 12,50"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <label className="tri-field">
                Payé par
                <select value={payerId} onChange={(e) => setPayerId(e.target.value)}>
                  {data.members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {m.id === data.me ? " (toi)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset className="tri-participants">
                <legend>Pour qui ? ({selected.size})</legend>
                <div className="tri-splitmode" role="group" aria-label="Mode de répartition">
                  <button
                    type="button"
                    className={splitMode === "equal" ? "on" : ""}
                    aria-pressed={splitMode === "equal"}
                    onClick={() => setSplitMode("equal")}
                  >
                    Équitable
                  </button>
                  <button
                    type="button"
                    className={splitMode === "shares" ? "on" : ""}
                    aria-pressed={splitMode === "shares"}
                    onClick={() => setSplitMode("shares")}
                  >
                    Par parts
                  </button>
                </div>
                {data.members.map((m) => {
                  const checked = selected.has(m.id);
                  const share = shareByMember.get(m.id);
                  const w = weights[m.id] ?? 1;
                  return (
                    <div key={m.id} className={"tri-check-row" + (checked ? " on" : "")}>
                      <label className="tri-check">
                        <input type="checkbox" checked={checked} onChange={() => toggle(m.id)} />
                        <span className="tri-check-name">
                          {shortName(m.name)}
                          {m.id === data.me ? " (toi)" : ""}
                        </span>
                      </label>
                      {checked && splitMode === "shares" && (
                        <span className="tri-parts">
                          <button
                            type="button"
                            className="tri-parts-btn"
                            onClick={() => adjustPart(m.id, -1)}
                            disabled={w <= 1}
                            aria-label={`Moins de parts pour ${m.name}`}
                          >
                            −
                          </button>
                          <span
                            className="tri-parts-value"
                            role="spinbutton"
                            aria-valuenow={w}
                            aria-valuemin={1}
                            aria-valuemax={MAX_PARTS}
                            aria-label={`Parts de ${m.name}`}
                          >
                            {w}
                          </span>
                          <button
                            type="button"
                            className="tri-parts-btn"
                            onClick={() => adjustPart(m.id, 1)}
                            disabled={w >= MAX_PARTS}
                            aria-label={`Plus de parts pour ${m.name}`}
                          >
                            +
                          </button>
                          <span className="tri-parts-unit">{w > 1 ? "parts" : "part"}</span>
                        </span>
                      )}
                      {checked && share !== undefined && (
                        <span className="tri-share">{fmtEuros(share)}</span>
                      )}
                    </div>
                  );
                })}
              </fieldset>
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={closeExpense}
                  disabled={busy}
                >
                  Annuler
                </button>
                <button type="submit" disabled={busy}>
                  {busy
                    ? "Enregistrement…"
                    : editingId
                      ? "Enregistrer les modifications"
                      : "Enregistrer"}
                </button>
              </div>
            </form>
        </Dialog>
      )}

      {/* Modale « j'ai remboursé » */}
      {refundFor && (
        <Dialog
          onClose={() => !busy && setRefundFor(null)}
          closeOnOverlay={!busy}
          label="Enregistrer un remboursement"
        >
            <h3>💸 Remboursement</h3>
            <p className="muted tiny">
              Tricount du {prettyDate(refundFor.date)}. La date et l'heure du
              remboursement seront enregistrées.
            </p>
            <form onSubmit={submitRefund} className="tri-form">
              <label className="tri-field">
                Qui a remboursé ?
                {/* Toujours l'utilisateur connecté : chacun déclare SES remboursements. */}
                <input
                  type="text"
                  value={data.members.find((m) => m.id === data.me)?.fullName ?? ""}
                  disabled
                  readOnly
                />
              </label>
              <label className="tri-field">
                Remboursé à
                <select value={refundTo} onChange={(e) => pickRefundTo(e.target.value)}>
                  {refundOptions.map((o) => (
                    <option key={o.toId} value={o.toId}>
                      {o.toName} — {fmtEuros(o.amountCents)} suggérés
                    </option>
                  ))}
                </select>
              </label>
              <input
                type="text"
                inputMode="decimal"
                placeholder="Montant en € — ex. 12,50"
                value={refundAmount}
                onChange={(e) => setRefundAmount(e.target.value)}
              />
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setRefundFor(null)}
                  disabled={busy}
                >
                  Annuler
                </button>
                <button type="submit" disabled={busy}>
                  {busy ? "Enregistrement…" : "Enregistrer"}
                </button>
              </div>
            </form>
        </Dialog>
      )}

      {/* Confirmation de suppression */}
      {confirmDelete && (
        <Dialog onClose={() => setConfirmDelete(null)} label="Supprimer la ligne">
            <h3>Supprimer cette ligne ?</h3>
            <p>
              {confirmDelete.label} — {fmtEuros(confirmDelete.amountCents)} (
              {confirmDelete.payerName})
            </p>
            {!confirmDelete.isRefund && (
              <p className="muted tiny">
                Les validations « OK pour rembourser » de ce tricount seront remises à
                zéro.
              </p>
            )}
            <div className="modal-actions">
              <button className="secondary" onClick={() => setConfirmDelete(null)}>
                Garder
              </button>
              <button className="danger" onClick={doDelete}>
                Supprimer
              </button>
            </div>
        </Dialog>
      )}
    </section>
  );
}
