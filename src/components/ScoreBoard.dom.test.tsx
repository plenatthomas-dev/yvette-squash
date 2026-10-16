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
  boxProposed: false,
  firstBox: { home: "right", away: "right" },
  status: "live",
  winner: null,
  ...over,
});

function monte(first: "home" | "away" | undefined, state = etat()) {
  const onPoint = vi.fn();
  const onFirstServe = vi.fn();
  const onToggleBox = vi.fn();
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
      onToggleBox={onToggleBox}
      onUndo={vi.fn()}
      onSkipBreak={vi.fn()}
      onBack={vi.fn()}
      onFinish={vi.fn()}
      first={first}
    />,
  );
  return { ...r, onPoint, onFirstServe, onToggleBox };
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
    const boutons = container.querySelectorAll(".ics-ask-row button");
    // Deux réponses, pas quatre : le carré ne se demande plus, il se propose.
    expect(boutons).toHaveLength(2);
    expect(boutons[0].textContent).toBe("Gérard sert");
    fireEvent.click(boutons[0]);
    expect(onFirstServe).toHaveBeenCalledWith("away");
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

// ============================================================================
//  LE CARRÉ DE SERVICE, PROPOSÉ ET FACULTATIF (demande du club, 2026-10-16)
// ============================================================================
describe("ScoreBoard — le carré de service", () => {
  it("s'affiche sur la case du SERVEUR seulement, et se distingue en proposition", () => {
    const { container } = monte("home", etat({ serving: "away", servingBox: "right", boxProposed: true }));
    const cellules = container.querySelectorAll(".ics-cell");
    expect(cellules[0].querySelector(".ics-box")).toBeNull();
    const pastille = cellules[1].querySelector(".ics-box");
    expect(pastille?.textContent).toBe("D?");
    expect(pastille?.classList.contains("is-proposed")).toBe(true);
  });

  it("perd son « ? » quand le carré découle de la règle", () => {
    const { container } = monte("home", etat({ serving: "home", servingBox: "left", boxProposed: false }));
    const pastille = container.querySelector(".ics-box");
    expect(pastille?.textContent).toBe("G");
    expect(pastille?.classList.contains("is-proposed")).toBe(false);
  });

  it("un appui change le carré — et ne marque AUCUN point", () => {
    const { getByRole, onToggleBox, onPoint } = monte("home", etat({ boxProposed: true }));
    fireEvent.click(getByRole("button", { name: /Thomas sert à gauche \(proposé\)/ }));
    expect(onToggleBox).toHaveBeenCalledTimes(1);
    expect(onPoint).not.toHaveBeenCalled();
  });

  it("ne bloque jamais le point : les deux cases restent actives sur une proposition", () => {
    const { getByLabelText } = monte("home", etat({ boxProposed: true }));
    expect((getByLabelText("Point pour Thomas") as HTMLButtonElement).disabled).toBe(false);
    expect((getByLabelText("Point pour Gérard") as HTMLButtonElement).disabled).toBe(false);
  });

  it("n'est pas un bouton DANS le bouton du point", () => {
    const { container } = monte("home");
    expect(container.querySelector(".ics-side .ics-box")).toBeNull();
    expect(container.querySelector(".ics-cell > .ics-box")).not.toBeNull();
  });
});
