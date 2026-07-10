"use client";

// Dialogue de confirmation (extrait de page.tsx) : remplace confirm() natif. La page
// ouvre le dialogue via une promesse (askConfirm) résolue au clic. Types exportés car
// la page s'en sert (opts passés à askConfirm, état stocké dans un useState).

import { Dialog } from "@/components/Dialog";

export type ConfirmOpts = {
  title: string;
  body: string;
  lines?: string[]; // si fourni, affiché en liste (une réservation par ligne) sous le body
  confirmLabel: string;
  danger?: boolean;
};
export type ConfirmState = (ConfirmOpts & { resolve: (v: boolean) => void }) | null;

export function ConfirmDialog({
  state,
  onResolve,
}: {
  state: ConfirmState;
  onResolve: (v: boolean) => void;
}) {
  if (!state) return null;
  return (
    <Dialog onClose={() => onResolve(false)} label={state.title}>
      <h3>{state.title}</h3>
      <p>{state.body}</p>
      {state.lines && state.lines.length > 0 && (
        <ul className="confirm-lines">
          {state.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      <div className="modal-actions">
        <button className="secondary" onClick={() => onResolve(false)}>
          Retour
        </button>
        <button
          className={state.danger ? "danger" : ""}
          onClick={() => onResolve(true)}
        >
          {state.confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
