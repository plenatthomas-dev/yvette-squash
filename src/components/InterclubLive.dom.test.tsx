import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
// Pas de `waitFor` ici : il s'appuie sur des minuteurs, et l'horloge de ces tests est simulée.
// On flanche donc explicitement les micro-tâches (`souffle`), ce qui est de toute façon plus
// franc — on dit ce qu'on attend au lieu de scruter jusqu'à ce que ça passe.
import { render, act, fireEvent } from "@testing-library/react";
import InterclubLive from "@/components/InterclubLive";

// LES TROIS GARDE-FOUS DE SONDAGE.
//
// L'en-tête d'`InterclubLive` promet trois choses, et `docs/interclub.md` en fait un engagement
// de coût : « aucun intervalle les jours sans rencontre ». Elles étaient toutes les trois
// contournées, sans qu'aucune erreur ne soit nécessaire — il suffisait que le parent se rende.
//
// `load` est la dépendance des trois effets du fichier. Son identité changeait avec celle du
// rappel `onExpired` reçu du parent, et alors :
//   * le chargement de montage repartait SANS consulter `somethingToWatch` ni `givenUp` ;
//   * l'intervalle était démonté puis remonté, donc `ticks` retombait à zéro — la cadence de
//     veille (`ticks % 6`) ne pouvait plus jamais atteindre son sixième tour ;
//   * `onForeground` se réabonnait, perdant le dédoublonnage qu'il existe pour garantir.
//
// Ces tests mesurent donc des REQUÊTES, pas des pixels. C'est la seule unité dans laquelle la
// promesse est écrite.

let calls: string[] = [];
/** Ce que le serveur répond ; changé par chaque test avant le montage. */
let charge: unknown = { fixtures: [] };

function rencontre(statut: string) {
  return {
    id: `f-${statut}`,
    date: "2026-09-03",
    teamId: "t1",
    teamName: "Équipe 1",
    opponent: "Massy",
    home: true,
    status: statut,
    score: { home: 0, away: 0 },
    matches: [],
  };
}

/**
 * Réponse MINIMALE, et non un vrai `Response` : `readOk` n'en lit que `ok`, `status` et `json`.
 * Un vrai `Response` fait passer son corps par un flux, dont la lecture n'est plus une simple
 * micro-tâche — sous horloge simulée, plus rien ne se résout et le test expire au lieu
 * d'échouer. On donne donc exactement ce que le lecteur consomme, pas un octet de plus.
 */
function reponse(corps: unknown): Response {
  return { ok: true, status: 200, json: async () => corps } as unknown as Response;
}

/**
 * Rend la main aux micro-tâches sans avancer l'horloge simulée.
 *
 * Généreux à dessein : entre le `fetch` et le `setState`, la réponse traverse `readOk`, puis
 * `readJson`, puis `json()`. Compter les sauts un par un rendrait ces tests solidaires du
 * nombre d'`await` que traverse une réponse, ce qui n'est le sujet d'aucun d'eux.
 */
async function souffle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

/** Avance l'horloge simulée ET laisse les réponses se résoudre. */
async function avance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

/** Parent volontairement instable : rappel recréé à chaque rendu, comme l'était `page.tsx`. */
function Banc() {
  const [tours, setTours] = useState(0);
  return (
    <>
      <button data-testid="rendre" onClick={() => setTours((n) => n + 1)}>
        {tours}
      </button>
      <InterclubLive onExpired={(status) => status === 401} />
    </>
  );
}

beforeEach(() => {
  calls = [];
  charge = { fixtures: [] };
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return reponse(charge);
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("InterclubLive — le sondage ne dépend que de ce qu'il y a à voir", () => {
  it("n'ouvre AUCUN intervalle quand tout est terminé, même si le parent se rend sans arrêt", async () => {
    charge = { fixtures: [rencontre("done")] };
    const { getByTestId } = render(<Banc />);

    await souffle();
    expect(calls.length).toBe(1);

    // Dix rendus du parent — un toast affiché ailleurs dans l'appli, puis sa disparition,
    // produisent exactement cela.
    for (let i = 0; i < 10; i++) {
      fireEvent.click(getByTestId("rendre"));
      await souffle();
    }
    expect(getByTestId("rendre").textContent).toBe("10");

    // Et deux minutes d'horloge : s'il restait un intervalle, il aurait tiré douze fois.
    await avance(120_000);

    expect(calls.length).toBe(1);
  });

  it("respecte la cadence de VEILLE : une requête par minute tant que rien n'est en cours", async () => {
    charge = { fixtures: [rencontre("scheduled")] };
    render(<Banc />);

    await souffle();
    expect(calls.length).toBe(1);

    // Cinq tics de 10 s : la cadence de veille n'est pas atteinte, rien ne part.
    await avance(50_000);
    expect(calls.length).toBe(1);

    // Le sixième tic ferme la minute — et c'est LUI qui sonde.
    await avance(10_000);
    expect(calls.length).toBe(2);
  });

  it("ne remet pas le compteur de tics à zéro quand le parent se rend", async () => {
    charge = { fixtures: [rencontre("scheduled")] };
    const { getByTestId } = render(<Banc />);
    await souffle();
    expect(calls.length).toBe(1);

    // Cinquante secondes s'écoulent, puis le parent se rend. C'est le remontage de l'intervalle
    // qui remettait `ticks` à zéro : la minute ne se refermait jamais, et la cadence de veille
    // annoncée n'existait pas.
    await avance(50_000);
    fireEvent.click(getByTestId("rendre"));
    await souffle();

    // ⚠️ CETTE ASSERTION-CI EST CELLE QUI DISCRIMINE. Sans elle, le test se contenterait de la
    // requête PARASITE que le rendu déclenchait — il passait alors grâce au défaut qu'il est
    // censé interdire, en confondant « la minute s'est refermée » avec « le montage a resondé ».
    expect(calls.length).toBe(1);

    // La minute se referme sur le tic suivant, le compteur n'ayant pas été remis à zéro.
    await avance(10_000);
    expect(calls.length).toBe(2);
  });
});

// CE PANNEAU MONTRE DEUX ÉTATS, PAS UN.
//
// Il porte le titre « En direct », mais il liste les rencontres du JOUR — c'est toute la raison
// d'être de la cadence de veille ci-dessus, qui existe pour voir la sienne démarrer. Une
// rencontre prévue ce soir y figurait donc avec exactement le même cadre, le même fond et un
// score 0–0 qu'une rencontre commencée où personne n'a encore marqué : deux états, un seul
// traitement, ce que DESIGN.md interdit nommément (« Règle des Trois Traitements »).
//
// Le vocabulaire existait déjà ailleurs dans l'interclub — pastille `.ic-status` et voile
// `--live-wash` — et c'est lui qui est repris, plutôt qu'un signal de plus inventé ici.
describe("InterclubLive — une rencontre en cours ne ressemble pas à une rencontre prévue", () => {
  it("peint et étiquette « En cours » la rencontre commencée", async () => {
    charge = { fixtures: [rencontre("live")] };
    const { container, getByText } = render(<Banc />);
    await souffle();

    expect(getByText("En cours")).toBeTruthy();
    expect(container.querySelector(".ic-live-card.is-live")).toBeTruthy();
  });

  it("laisse la rencontre PRÉVUE sans voile, et le dit", async () => {
    charge = { fixtures: [rencontre("scheduled")] };
    const { container, getByText } = render(<Banc />);
    await souffle();

    expect(getByText("À venir")).toBeTruthy();
    // C'est l'absence de voile qui compte : la peinture est réservée au seul état qui demande
    // qu'on regarde maintenant.
    expect(container.querySelector(".ic-live-card")).toBeTruthy();
    expect(container.querySelector(".ic-live-card.is-live")).toBeNull();
  });
});
