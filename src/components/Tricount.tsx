"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

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
  participantNames: string[];
  canDelete: boolean;
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
}
interface TricountData {
  me: string;
  members: Member[];
  tricounts: TricountItem[];
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

function prettyDate(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/** Horodatage précis d'un remboursement : "03/07/2026 à 21:15". */
function fmtStamp(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleDateString("fr-FR") +
    " à " +
    d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
  );
}

function todayISO(): string {
  return new Date().toLocaleDateString("en-CA");
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
  // Tricount déplié (au plus un ; "" = tous repliés, null = pas encore initialisé)
  const [openId, setOpenId] = useState<string | null>(null);

  // Formulaire « nouvelle dépense »
  const [expenseOpen, setExpenseOpen] = useState(false);
  // Tricount cible : soit la date d'un tricount existant, soit "new" (nouvelle date).
  const [tcChoice, setTcChoice] = useState<string>("new");
  const [date, setDate] = useState(todayISO());
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [payerId, setPayerId] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Formulaire « j'ai remboursé » (rattaché à UN tricount prêt ; le rembourseur
  // est TOUJOURS l'utilisateur connecté)
  const [refundFor, setRefundFor] = useState<TricountItem | null>(null);
  const [refundTo, setRefundTo] = useState("");
  const [refundAmount, setRefundAmount] = useState("");

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
    // Pré-sélection : le tricount d'aujourd'hui s'il existe, sinon « nouvelle date ».
    setTcChoice(data.tricounts.some((t) => t.date === today) ? today : "new");
    setLabel("");
    setAmount("");
    setPayerId(data.me);
    setSelected(new Set(data.members.map((m) => m.id)));
    setExpenseOpen(true);
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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
    setBusy(true);
    try {
      const res = await fetch("/api/tricount/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: targetDate,
          label: label.trim(),
          amountCents: cents,
          payerId,
          participantIds: [...selected],
        }),
      });
      if (onExpired(res.status)) return;
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `Erreur ${res.status}`);
      toast("ok", "Dépense enregistrée");
      setExpenseOpen(false);
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

  // Mon solde global = somme de mes soldes sur tous les tricounts non soldés.
  const myGlobal = useMemo(() => {
    if (!data) return 0;
    return data.tricounts.reduce(
      (s, t) => s + (t.balances.find((b) => b.userId === data.me)?.cents ?? 0),
      0,
    );
  }, [data]);

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

      <div className="tri-actions">
        <button onClick={openExpense} disabled={busy}>
          ➕ Nouvelle dépense
        </button>
      </div>

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
                          {e.canDelete && !t.settled && (
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
                            <strong>{tr.toName}</strong>
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
              </div>
            )}
          </article>
        );
      })}

      {/* Modale « nouvelle dépense » */}
      {expenseOpen && (
        <div className="modal-overlay" onClick={() => !busy && setExpenseOpen(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Nouvelle dépense"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>➕ Nouvelle dépense</h3>
            <form onSubmit={submitExpense} className="tri-form">
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
                  <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </label>
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
                {data.members.map((m) => (
                  <label key={m.id} className="tri-check">
                    <input
                      type="checkbox"
                      checked={selected.has(m.id)}
                      onChange={() => toggle(m.id)}
                    />
                    {m.name}
                    {m.id === data.me ? " (toi)" : ""}
                  </label>
                ))}
              </fieldset>
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setExpenseOpen(false)}
                  disabled={busy}
                >
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

      {/* Modale « j'ai remboursé » */}
      {refundFor && (
        <div className="modal-overlay" onClick={() => !busy && setRefundFor(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Enregistrer un remboursement"
            onClick={(e) => e.stopPropagation()}
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
            aria-label="Supprimer la ligne"
            onClick={(e) => e.stopPropagation()}
          >
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
          </div>
        </div>
      )}
    </section>
  );
}
