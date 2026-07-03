"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

// Vue « Frais » : partage de dépenses type Tricount entre membres de l'asso.
// Tout vient de GET /api/tricount (membres, dépenses, soldes, remboursements
// suggérés) ; les montants transitent en centimes et ne deviennent des euros
// qu'à l'affichage.

interface Member {
  id: string;
  name: string;
}
interface ExpenseItem {
  id: string;
  label: string;
  amountCents: number;
  isRefund: boolean;
  spentAt: string;
  payerId: string;
  payerName: string;
  participantNames: string[];
  canDelete: boolean;
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
interface TricountData {
  me: string;
  members: Member[];
  expenses: ExpenseItem[];
  balances: BalanceItem[];
  transfers: TransferItem[];
}

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

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "short",
  });
}

interface Props {
  toast: (type: "ok" | "err" | "info", msg: string) => void;
  onExpired: (status: number) => boolean;
}

export default function Tricount({ toast, onExpired }: Props) {
  const [data, setData] = useState<TricountData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // Formulaire d'ajout : "expense" (dépense partagée) ou "refund" (j'ai remboursé).
  const [formOpen, setFormOpen] = useState<null | "expense" | "refund">(null);
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [payerId, setPayerId] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<ExpenseItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/tricount");
      if (onExpired(r.status)) return;
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `Erreur ${r.status}`);
      setData(j as TricountData);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [onExpired]);

  useEffect(() => {
    load();
  }, [load]);

  const openForm = (mode: "expense" | "refund") => {
    if (!data) return;
    setLabel("");
    setAmount("");
    setPayerId(data.me);
    // Dépense : tout le monde participe par défaut ; remboursement : personne
    // (on choisit LE bénéficiaire).
    setSelected(
      mode === "expense" ? new Set(data.members.map((m) => m.id)) : new Set(),
    );
    setFormOpen(mode);
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      // Remboursement : sélection exclusive (un seul bénéficiaire).
      if (formOpen === "refund") return new Set(prev.has(id) ? [] : [id]);
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !data || !formOpen) return;
    const refund = formOpen === "refund";
    const cents = parseEuros(amount);
    if (cents === null || cents === 0) {
      toast("err", "Montant invalide — ex. 12,50");
      return;
    }
    if (!refund && !label.trim()) {
      toast("err", "Donne un libellé à la dépense.");
      return;
    }
    if (selected.size === 0) {
      toast("err", refund ? "Choisis à qui tu as remboursé." : "Choisis au moins un participant.");
      return;
    }
    if (refund && selected.has(payerId)) {
      toast("err", "On ne se rembourse pas soi-même.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/tricount/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: label.trim(),
          amountCents: cents,
          payerId,
          participantIds: [...selected],
          isRefund: refund,
        }),
      });
      if (onExpired(res.status)) return;
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `Erreur ${res.status}`);
      toast("ok", refund ? "Remboursement enregistré" : "Dépense enregistrée");
      setFormOpen(null);
      load();
    } catch (e) {
      toast("err", "Enregistrement impossible : " + (e as Error).message);
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

  const myBalance = useMemo(
    () => data?.balances.find((b) => b.userId === data.me)?.cents ?? 0,
    [data],
  );

  if (loading && !data) return <p className="muted">Chargement des frais…</p>;
  if (error) return <div className="notice error" role="alert">⚠️ {error}</div>;
  if (!data) return null;

  const total = data.expenses
    .filter((e) => !e.isRefund)
    .reduce((s, e) => s + e.amountCents, 0);

  return (
    <section className="tricount">
      {/* Soldes */}
      <div className="tri-summary">
        <p className={"tri-me " + (myBalance > 0 ? "pos" : myBalance < 0 ? "neg" : "")}>
          {myBalance > 0
            ? `On te doit ${fmtEuros(myBalance)}`
            : myBalance < 0
              ? `Tu dois ${fmtEuros(-myBalance)}`
              : "Tu es à l'équilibre 👌"}
        </p>
        <p className="muted tiny">
          Total des dépenses partagées : {fmtEuros(total)}
        </p>
      </div>

      <div className="tri-actions">
        <button onClick={() => openForm("expense")} disabled={busy}>
          ➕ Nouvelle dépense
        </button>
        <button className="secondary" onClick={() => openForm("refund")} disabled={busy}>
          💸 J'ai remboursé
        </button>
      </div>

      {data.balances.length > 0 && (
        <div className="tri-block">
          <h2>⚖️ Soldes</h2>
          <ul className="tri-balances">
            {[...data.balances]
              .sort((a, b) => b.cents - a.cents)
              .map((b) => (
                <li key={b.userId} className={b.userId === data.me ? "mine" : ""}>
                  <span>{b.name}{b.userId === data.me && " (toi)"}</span>
                  <strong className={b.cents > 0 ? "pos" : b.cents < 0 ? "neg" : ""}>
                    {b.cents > 0 ? "+" : ""}
                    {fmtEuros(b.cents)}
                  </strong>
                </li>
              ))}
          </ul>
        </div>
      )}

      {data.transfers.length > 0 && (
        <div className="tri-block">
          <h2>🔁 Pour tout équilibrer</h2>
          <ul className="tri-transfers">
            {data.transfers.map((t, i) => (
              <li key={i} className={t.fromId === data.me || t.toId === data.me ? "mine" : ""}>
                <span>
                  <strong>{t.fromName}</strong> rembourse <strong>{t.toName}</strong>
                </span>
                <strong>{fmtEuros(t.amountCents)}</strong>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="tri-block">
        <h2>🧾 Dépenses</h2>
        {data.expenses.length === 0 ? (
          <p className="muted">
            Aucune dépense pour le moment. Balles, cordages, pots d'après-match :
            ajoute la première !
          </p>
        ) : (
          <ul className="tri-expenses">
            {data.expenses.map((e) => (
              <li key={e.id} className={e.isRefund ? "refund" : ""}>
                <div className="tri-line">
                  <span className="tri-label">
                    {e.isRefund ? "💸 " : ""}
                    <strong>{e.label}</strong>
                    <small>
                      {fmtDay(e.spentAt)} · {e.payerName}
                      {e.isRefund
                        ? ` → ${e.participantNames.join(", ")}`
                        : ` a payé pour ${e.participantNames.length} pers.`}
                    </small>
                  </span>
                  <span className="tri-amount">
                    <strong>{fmtEuros(e.amountCents)}</strong>
                    {e.canDelete && (
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
        )}
      </div>

      {/* Modale d'ajout */}
      {formOpen && (
        <div className="modal-overlay" onClick={() => !busy && setFormOpen(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={formOpen === "refund" ? "Enregistrer un remboursement" : "Nouvelle dépense"}
            onClick={(e) => e.stopPropagation()}
          >
            <h3>{formOpen === "refund" ? "💸 J'ai remboursé" : "➕ Nouvelle dépense"}</h3>
            <form onSubmit={submit} className="tri-form">
              {formOpen === "expense" && (
                <input
                  type="text"
                  placeholder="Libellé (balles, cordage, pot…)"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  maxLength={80}
                  autoFocus
                />
              )}
              <input
                type="text"
                inputMode="decimal"
                placeholder="Montant en € — ex. 12,50"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                autoFocus={formOpen === "refund"}
              />
              <label className="tri-field">
                {formOpen === "refund" ? "Qui a remboursé ?" : "Payé par"}
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
                <legend>
                  {formOpen === "refund" ? "Remboursé à" : `Pour qui ? (${selected.size})`}
                </legend>
                {data.members.map((m) => (
                  <label key={m.id} className="tri-check">
                    <input
                      type={formOpen === "refund" ? "radio" : "checkbox"}
                      name={formOpen === "refund" ? "beneficiary" : undefined}
                      checked={selected.has(m.id)}
                      onChange={() => toggle(m.id)}
                      disabled={formOpen === "refund" && m.id === payerId}
                    />
                    {m.name}
                    {m.id === data.me ? " (toi)" : ""}
                  </label>
                ))}
              </fieldset>
              <div className="modal-actions">
                <button type="button" className="secondary" onClick={() => setFormOpen(null)} disabled={busy}>
                  Annuler
                </button>
                <button type="submit" disabled={busy}>
                  {busy ? "Enregistrement…" : "Enregistrer"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirmation de suppression */}
      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Supprimer la dépense"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>Supprimer cette ligne ?</h3>
            <p>
              {confirmDelete.label} — {fmtEuros(confirmDelete.amountCents)} (
              {confirmDelete.payerName})
            </p>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setConfirmDelete(null)}>
                Garder
              </button>
              <button className="danger" onClick={doDelete}>
                Supprimer
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
