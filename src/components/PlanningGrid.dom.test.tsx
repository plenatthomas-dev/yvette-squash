import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PlanningGrid } from "./PlanningGrid";
import type { PlanningDay, Slot } from "@/lib/resamania/types";

// LA GRILLE DU JOUR AU CLAVIER ET AU LECTEUR D'ÉCRAN (audit 2026-10, point 29).
//
//  * chaque case dit son TERRAIN, son HORAIRE et son état — une case « Libre » seule ne disait
//    pas lequel ;
//  * UN seul arrêt de Tab pour toute la grille (tabindex roulant) : les flèches s'y déplacent.

const slot = (id: string, court: string, startsAt: string, over: Partial<Slot> = {}): Slot => ({
  id,
  courtId: court,
  courtName: court === "t1" ? "Squash 1" : "Squash 2",
  startsAt,
  endsAt: startsAt,
  status: "free",
  bookable: true,
  remaining: 1,
  ...over,
});

const H18 = "2099-03-01T17:00:00.000Z";
const H19 = "2099-03-01T18:00:00.000Z";

const planning: PlanningDay = {
  date: "2099-03-01",
  clubId: "c",
  courts: [
    { id: "t1", name: "Squash 1" },
    { id: "t2", name: "Squash 2" },
  ],
  slots: [
    slot("a", "t1", H18),
    slot("b", "t2", H18),
    slot("c", "t1", H19),
    slot("d", "t2", H19, { bookable: false, status: "booked", bookedBy: "Bob" }),
  ],
};

function monte(onBook = vi.fn()) {
  render(
    <PlanningGrid
      planning={planning}
      onBook={onBook}
      onCancelMine={vi.fn()}
      onTogglePresence={vi.fn()}
      onBookMany={vi.fn()}
      selMode={false}
      setSelMode={vi.fn()}
    />,
  );
  return onBook;
}

describe("PlanningGrid — accessibilité", () => {
  it("chaque case annonce terrain, horaire et état", () => {
    monte();
    const libres = screen.getAllByRole("button", { name: /Squash 1, \d\d:\d\d : libre, appuie pour réserver/ });
    expect(libres).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Squash 2, .* réservé par Bob/ })).toBeDefined();
  });

  it("une seule case est dans l'ordre de tabulation", () => {
    monte();
    const cases = screen.getAllByRole("button").filter((b) => b.tagName === "TD");
    expect(cases.filter((c) => c.tabIndex === 0)).toHaveLength(1);
    expect(cases.filter((c) => c.tabIndex === -1).length).toBe(cases.length - 1);
  });

  it("les flèches déplacent le focus, et l'arrêt de Tab suit", () => {
    monte();
    const premiere = screen.getAllByRole("button").find((b) => b.tabIndex === 0)!;
    premiere.focus();
    fireEvent.keyDown(premiere, { key: "ArrowRight" });
    const voisine = document.activeElement as HTMLElement;
    expect(voisine).not.toBe(premiere);
    expect(voisine.getAttribute("aria-label")).toMatch(/^Squash 2/);
    expect(voisine.tabIndex).toBe(0);
    expect(premiere.tabIndex).toBe(-1);
  });
});
