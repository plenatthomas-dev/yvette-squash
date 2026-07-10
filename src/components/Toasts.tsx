"use client";

// Toasts (extraits de page.tsx) : notifications éphémères en surimpression, remplaçant
// alert() natif (moche sur mobile). L'état vit dans la page ; ce composant ne fait que
// rendre la pile. Les types sont exportés car la page les utilise (callback `toast`, état).

export type ToastType = "ok" | "err" | "info";
export type Toast = { id: number; type: ToastType; msg: string };

const TOAST_ICON: Record<ToastType, string> = { ok: "✅", err: "⚠️", info: "ℹ️" };

export function Toasts({ items }: { items: Toast[] }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.type}`}>
          {TOAST_ICON[t.type]} {t.msg}
        </div>
      ))}
    </div>
  );
}
