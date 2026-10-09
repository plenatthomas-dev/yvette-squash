import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import ScoreBoard from "@/components/ScoreBoard";
import type { MatchState } from "@/lib/interclub";

// L'ÉQUIPE QUI REÇOIT EN PREMIER, sur l'écran de marquage (demande du club, 2026-10-09).
//
// `first` ne déplace que l'AFFICHAGE. Le piège qu'il faut tenir : la case de gauche, quand
// l'adversaire reçoit, est la SIENNE — un appui dessus doit marquer pour lui (`onPoint("away")`),
// pas pour la position « première case ». Le journal des points, la synchro et l'annulation
// parlent tous le sens de la donnée, où `home` est notre joueur.

/** Notre joueur (Thomas) mène 2 jeux à 1 ; dans le jeu en cours, 7-5. */
const etat = (over: Partial<MatchState> = {}): MatchState => ({
  games: [
    { home: 11, away: 8 },
    { home: 2, away: 11 },
    { home: 11, away: 9 },
  ],
  current: { home: 7, away: 5 },
  gamesWon: { home: 2, away: 1 },
  serving: "home",
  servingBox: "left",
  awaitingServeBox: false,
  status: "live",
  winner: null,
  ...over,
});

function monte(first: "home" | "away" | undefined, state = etat()) {
  const onPoint = vi.fn();
  const onFirstServe = vi.fn();
  const r = render(
    <ScoreBoard
      state={state}
      bestOf={5}
      homeName="Thomas"
      awayName="Gérard"
      homeColor={null}
      awayColor={null}
      meta="Match #1"
      canUndo
      remaining={0}
      onPoint={onPoint}
      onFirstServe={onFirstServe}
      onBox={vi.fn()}
      onUndo={vi.fn()}
      onSkipBreak={vi.fn()}
      onBack={vi.fn()}
      onFinish={vi.fn()}
      first={first}
    />,
  );
  return { ...r, onPoint, onFirstServe };
}

describe("ScoreBoard — l'équipe qui reçoit, en premier", () => {
  it("par défaut, notre joueur d'abord — le marqueur libre ne bouge pas", () => {
    const { container } = monte(undefined);
    const cases = container.querySelectorAll(".ics-side");
    expect(cases[0].querySelector(".ics-name")?.textContent).toBe("Thomas");
    expect(container.querySelector(".ics-history")?.textContent).toBe("11-8 · 2-11 · 11-9");
  });

  it("chez l'adversaire : sa case d'abord, ses chiffres d'abord", () => {
    const { container } = monte("away");
    const cases = container.querySelectorAll(".ics-side");
    expect(cases[0].querySelector(".ics-name")?.textContent).toBe("Gérard");
    expect(cases[0].querySelector(".ics-points")?.textContent).toBe("5");
    expect(cases[1].querySelector(".ics-points")?.textContent).toBe("7");
    expect(container.querySelector(".ics-history")?.textContent).toBe("8-11 · 11-2 · 9-11");
  });

  it("⚠️ un appui sur la PREMIÈRE case marque pour l'adversaire, pas pour « la première case »", () => {
    const { container, onPoint } = monte("away");
    fireEvent.click(container.querySelectorAll(".ics-side")[0]);
    expect(onPoint).toHaveBeenCalledWith("away");
    fireEvent.click(container.querySelectorAll(".ics-side")[1]);
    expect(onPoint).toHaveBeenLastCalledWith("home");
  });

  it("« Qui engage ? » propose l'adversaire en premier, et désigne le bon joueur", () => {
    const { container, onFirstServe } = monte("away", etat({ serving: null, servingBox: null }));
    const rangees = container.querySelectorAll(".ics-ask-row");
    expect(rangees[0].textContent).toContain("Gérard");
    fireEvent.click(rangees[0].querySelector("button") as HTMLElement);
    expect(onFirstServe).toHaveBeenCalledWith("away", "left");
  });

  it("le résultat donne les jeux du VAINQUEUR d'abord, de quelque côté qu'il soit", () => {
    const fini = etat({
      status: "done",
      winner: "away",
      gamesWon: { home: 1, away: 3 },
      current: { home: 0, away: 0 },
    });
    expect(monte("home", fini).container.querySelector(".ics-done")?.textContent).toBe(
      "Gérard l'emporte 3–1",
    );
  });
});
