import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { WeekGrid } from "./WeekGrid";
import { rang } from "./PlanningGrid";

// TEXTES DES GRILLES : une consigne qui dit quoi faire, et un rang qui s'écrit juste.

describe("rang (liste d'attente)", () => {
  it("écrit « 1er » pour le premier, « 2e », « 3e »… ensuite — plus « 1ᵉ »", () => {
    expect(rang(1)).toBe("1er");
    expect(rang(2)).toBe("2e");
    expect(rang(10)).toBe("10e");
  });
});

describe("WeekGrid — mode sélection", () => {
  it("donne la même consigne que la vue jour, et non « Sélection multi créneau »", () => {
    render(
      <WeekGrid
        days={[
          {
            date: "2027-03-01",
            planning: {
              date: "2027-03-01",
              clubId: "c",
              courts: [{ id: "t1", name: "Squash 1" }],
              slots: [
                {
                  id: "s1",
                  courtId: "t1",
                  courtName: "Squash 1",
                  startsAt: "2027-03-01T18:00:00.000Z",
                  endsAt: "2027-03-01T18:45:00.000Z",
                  status: "free",
                  bookable: true,
                  remaining: 1,
                },
              ],
            },
          },
        ]}
        filter={() => true}
        onPick={vi.fn()}
        onBook={vi.fn()}
        onCancelMine={vi.fn()}
        onTogglePresence={vi.fn()}
        onBookMany={vi.fn()}
        selMode
        setSelMode={vi.fn()}
      />,
    );
    expect(screen.queryByText(/Sélection multi créneau/)).toBeNull();
    expect(screen.getByText(/Touche les créneaux libres à réserver/).textContent).toContain(
      "Retouche l'icône de sélection pour quitter.",
    );
  });
});
