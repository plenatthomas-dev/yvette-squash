import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import InterclubScorer from "@/components/InterclubScorer";

// LA BORNE DES CINQ SECONDES.
//
// « Une écriture toutes les 5 s au plus » est affirmée dans TROIS documents — `schema.prisma`
// à propos de `liveJson`, l'en-tête d'`interclub-gate.ts` pour son modèle de coût, et
// `docs/interclub.md` — et rien ne la vérifiait : `SYNC_MS` n'apparaissait que dans le fichier
// qui le déclare.
//
// Ce n'est pas une borne théorique. Tout le modèle de coût de la soirée repose dessus : le
// Data Cache du direct est invalidé à CHAQUE écriture du marqueur, et chaque écriture est une
// transaction Serializable. La borne est ce qui rend le coût indépendant du nombre de points
// joués — donc du sport lui-même.
//
// Elle a déjà été fausse d'un facteur ~8, par une option `immediate` qui mettait l'attente à
// zéro sans regarder la dernière émission : elle valait pour chaque fin de jeu, chaque fin de
// match et chaque UNDO. Annuler cinq points d'affilée — le geste ordinaire quand on rattrape
// une inattention — envoyait cinq PUT en trois secondes. La porte a été refermée sans qu'aucun
// test ne vienne empêcher qu'on la rouvre. C'est ce test-ci.

const SYNC_MS = 5_000;

let ecritures = 0;

function reponse(): Response {
  return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
}

async function souffle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

async function avance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

/** Un simple vierge : le marqueur demande d'abord qui engage. */
const MATCH = {
  id: "m-cadence",
  order: 1,
  homeDisplayName: "Thomas",
  awayName: "Gérard",
  homeColor: null,
  awayColor: null,
  games: [] as { number: number; home: number; away: number }[],
};

function monte() {
  return render(
    <InterclubScorer
      fixtureId="f1"
      match={MATCH}
      bestOf={5}
      onClose={vi.fn()}
      onExpired={() => false}
      toast={vi.fn()}
    />,
  );
}

beforeEach(() => {
  ecritures = 0;
  localStorage.clear();
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      ecritures += 1;
      return reponse();
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("InterclubScorer — le nombre d'écritures ne suit pas le nombre de points", () => {
  it("n'écrit qu'UNE fois par fenêtre de 5 s, quel que soit le nombre de points marqués", async () => {
    const { getByLabelText, getByRole } = monte();
    await souffle();

    // Qui engage : c'est le premier `commit`, et la fenêtre étant vierge il part tout de suite.
    // (Un match vierge n'a plus de serveur par défaut : le marqueur le désigne, cf. `seedEvents`.)
    fireEvent.click(getByRole("button", { name: "Thomas · droite" }));
    await avance(0);
    expect(ecritures).toBe(1);

    // Dix échanges en une seconde. Chacun replanifie le même envoi, aucun ne l'avance.
    for (let i = 0; i < 10; i++) {
      fireEvent.click(getByLabelText("Point pour Thomas"));
      await avance(100);
    }
    expect(ecritures).toBe(1);

    // Jusqu'à la toute fin de la fenêtre, toujours rien.
    await avance(SYNC_MS - 1000 - 1);
    expect(ecritures).toBe(1);

    // Et la fenêtre écoulée, UNE écriture — pas dix.
    await avance(2);
    expect(ecritures).toBe(2);
  });

  it("ne s'ouvre pas de porte de sortie sur l'UNDO", async () => {
    const { getByText, getByLabelText, getByRole } = monte();
    await souffle();

    fireEvent.click(getByRole("button", { name: "Thomas · droite" }));
    await avance(0);
    for (let i = 0; i < 5; i++) {
      fireEvent.click(getByLabelText("Point pour Thomas"));
      await avance(50);
    }
    await avance(SYNC_MS);
    const apresLesPoints = ecritures;

    // Cinq annulations d'affilée : le geste qui envoyait cinq PUT en trois secondes.
    for (let i = 0; i < 5; i++) {
      fireEvent.click(getByText("↶ Annuler"));
      await avance(50);
    }

    // Rien n'est parti pendant la rafale…
    expect(ecritures).toBe(apresLesPoints);
    // …et une seule écriture la solde, une fois la fenêtre écoulée.
    await avance(SYNC_MS);
    expect(ecritures).toBe(apresLesPoints + 1);
  });
});
