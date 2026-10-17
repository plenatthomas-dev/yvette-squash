import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Toasts, toastDuration } from "./Toasts";

// UN TOAST D'ERREUR SE LIT JUSQU'AU BOUT, ET S'ÉCARTE D'UN APPUI.
//
// Avant : 3,5 s pour tout, erreurs comprises, et aucun moyen de fermer (pile entière en
// `pointer-events: none`). Le conteneur reste transparent aux appuis — c'est vérifié dans
// globals.css.test.ts, jsdom n'appliquant pas la feuille.

describe("toastDuration", () => {
  it("laisse 8 s à une erreur", () => {
    expect(toastDuration("err", "Présence non enregistrée")).toBe(8000);
  });
  it("laisse 6 s à une information longue (> 80 caractères)", () => {
    const long = "Réservation possible seulement via ResaMania. Ici tu peux te mettre « +1 » sur un créneau déjà réservé.";
    expect(long.length).toBeGreaterThan(80);
    expect(toastDuration("info", long)).toBe(6000);
  });
  it("garde 3,5 s pour une information courte et un succès", () => {
    expect(toastDuration("info", "Inscrit en liste d'attente 🕒")).toBe(3500);
    expect(toastDuration("ok", "Réservation confirmée")).toBe(3500);
  });
});

describe("Toasts", () => {
  it("un appui sur un toast le ferme", () => {
    const onDismiss = vi.fn();
    render(
      <Toasts
        items={[
          { id: 1, type: "err", msg: "Annulation impossible" },
          { id: 2, type: "ok", msg: "Réservation confirmée" },
        ]}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByText(/Annulation impossible/));
    expect(onDismiss).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByText(/Réservation confirmée/));
    expect(onDismiss).toHaveBeenLastCalledWith(2);
  });

  it("garde les erreurs dans la région assertive, le reste dans la région polie", () => {
    render(
      <Toasts
        items={[
          { id: 1, type: "err", msg: "Échec" },
          { id: 2, type: "info", msg: "Info" },
        ]}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Échec");
    expect(screen.getByRole("status").textContent).toContain("Info");
  });
});
