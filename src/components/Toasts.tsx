"use client";

// Toasts (extraits de page.tsx) : notifications éphémères en surimpression, remplaçant
// alert() natif (moche sur mobile). L'état vit dans la page ; ce composant ne fait que
// rendre la pile. Les types sont exportés car la page les utilise (callback `toast`, état).

export type ToastType = "ok" | "err" | "info";
export type Toast = { id: number; type: ToastType; msg: string };

const TOAST_ICON: Record<ToastType, string> = { ok: "✅", err: "⚠️", info: "ℹ️" };

export function Toasts({ items }: { items: Toast[] }) {
  // DEUX régions live, et il en faut deux. Tout passait auparavant en `role="status"`
  // (poli) : une erreur se mettait donc en file derrière les annonces de chargement et
  // pouvait n'arriver qu'après avoir été retirée du DOM. Les erreurs passent en
  // `role="alert"` (assertif, annoncé tout de suite) ; succès et infos restent polis pour
  // ne pas couper la lecture en cours.
  const errors = items.filter((t) => t.type === "err");
  const others = items.filter((t) => t.type !== "err");
  return (
    <div className="toasts">
      <div className="toasts-stack" role="alert" aria-live="assertive">
        {errors.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>
            {TOAST_ICON[t.type]} {t.msg}
          </div>
        ))}
      </div>
      <div className="toasts-stack" role="status" aria-live="polite">
        {others.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>
            {TOAST_ICON[t.type]} {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
