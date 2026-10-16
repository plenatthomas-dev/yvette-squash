import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import InterclubScorer from "@/components/InterclubScorer";

// QUI ENGAGE.
//
// Le premier service d'un match se tire au sort sur le terrain. Ni l'appli ni le serveur ne
// peuvent le connaître : seul le marqueur, qui est là, peut le saisir. Le CARRÉ, lui, se
// propose (« D? » sur la case du serveur) et se corrige d'un appui facultatif — on ne le
// demande plus (demande du club, 2026-10-16).
//
// L'écran savait le demander — il porte un panneau « Qui engage ? » conditionné à
// `serving === null` — mais ce panneau était INATTEIGNABLE : `seedEvents` posait « le joueur
// qui reçoit sert, à droite » avant même qu'on ouvre la bouche. Le marqueur se retrouvait donc
// avec un serveur imposé, faux une fois sur deux, et le carré avec.
//
// Ce fichier vérifie les deux moitiés de la correction : le panneau s'affiche, ET les cases de
// points sont inertes tant qu'on n'a pas répondu. La seconde compte autant que la première :
// `applyPoint` ignore un point sans serveur, donc des cases actives auraient absorbé les appuis
// en silence — le pire état pour un écran qu'on utilise sans le regarder, au bord du terrain.

function reponse(): Response {
  return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
}

async function souffle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

const vierge = {
  id: "m-service",
  order: 1,
  homeDisplayName: "Thomas",
  awayName: "Gérard",
  homeColor: null,
  awayColor: null,
  games: [] as { number: number; home: number; away: number }[],
  // Aucun jeu en cours côté serveur : ces cas éprouvent le marquage à partir de rien.
  live: null,
};

/** Le même simple, mais dont un jeu est déjà enregistré : il n'y a plus rien à demander. */
const entame = { ...vierge, id: "m-entame", games: [{ number: 1, home: 11, away: 5 }] };

function monte(match: typeof vierge) {
  return render(
    <InterclubScorer
      fixtureId="f1"
      match={match}
      bestOf={5}
      onClose={vi.fn()}
      onExpired={() => false}
      toast={vi.fn()}
    />,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => reponse()));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("InterclubScorer — le premier service se saisit, il ne se suppose pas", () => {
  it("demande qui engage sur un match vierge — le serveur seulement", async () => {
    const { getByText, getByRole, queryByRole } = monte(vierge);
    await souffle();

    expect(getByText("Qui engage ?")).toBeDefined();
    expect(getByRole("button", { name: "Thomas sert" })).toBeDefined();
    expect(getByRole("button", { name: "Gérard sert" })).toBeDefined();
    // Le carré ne fait plus partie de la question.
    expect(queryByRole("button", { name: /gauche|droite/ })).toBeNull();
  });

  it("garde les cases de points INERTES tant que personne n'a répondu", async () => {
    const { getByLabelText } = monte(vierge);
    await souffle();

    // Désactivées, et non « actives mais sans effet » : `applyPoint` ignorerait le point, et
    // l'écran mentirait sur ce qu'il vient d'enregistrer.
    expect((getByLabelText("Point pour Thomas") as HTMLButtonElement).disabled).toBe(true);
    expect((getByLabelText("Point pour Gérard") as HTMLButtonElement).disabled).toBe(true);
  });

  it("ouvre le marquage sur la réponse, et sur celle-là seulement", async () => {
    const { getByLabelText, getByRole, queryByText } = monte(vierge);
    await souffle();

    // Le marqueur désigne l'ADVERSAIRE : rien de ce que l'appli aurait supposé.
    fireEvent.click(getByRole("button", { name: "Gérard sert" }));
    await souffle();

    expect(queryByText("Qui engage ?")).toBeNull();
    // Le carré se PROPOSE sur sa case, sans rien attendre.
    expect(getByRole("button", { name: /Gérard sert à droite \(proposé\)/ })).toBeDefined();
    expect((getByLabelText("Point pour Thomas") as HTMLButtonElement).disabled).toBe(false);
    expect((getByLabelText("Point pour Gérard") as HTMLButtonElement).disabled).toBe(false);
  });

  it("ne pose PAS la question quand un jeu est déjà enregistré", async () => {
    // Reprise d'un match saisi ailleurs : le serveur des jeux passés n'a plus d'importance, et
    // le déroulé reconstitué est assumé comme inventé. On ne rouvre pas une question réglée.
    const { queryByText, getByRole } = monte(entame);
    await souffle();

    expect(queryByText("Qui engage ?")).toBeNull();

    // Le carré, lui, est une PROPOSITION : au jeu suivant, le règlement désigne le serveur — le
    // vainqueur du jeu précédent — mais lui laisse le choix du carré. L'appli le propose et
    // laisse corriger ; elle ne bloque plus le point en attendant une réponse.
    expect(getByRole("button", { name: /Thomas sert à droite \(proposé\)/ })).toBeDefined();
  });
});
