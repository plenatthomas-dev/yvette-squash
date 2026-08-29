import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, act, waitFor, fireEvent } from "@testing-library/react";
import Interclub from "@/components/Interclub";

// LA BOUCLE DE REQUÊTES SANS FIN.
//
// Ce que ce fichier vérifie tient en une phrase : le nombre de requêtes émises par cet écran ne
// dépend PAS de la fréquence à laquelle son parent se rend.
//
// C'est une propriété facile à perdre sans s'en apercevoir, parce qu'elle ne se voit pas à la
// lecture d'un seul fichier. `loadList` est un `useCallback` dont l'effet de montage dépend, et
// ses dépendances sont les rappels que le parent nous passe. Une fonction nue là-haut — le cas
// le plus banal qui soit — et chaque rendu du parent relance le chargement. Comme le `catch` de
// `loadList` toaste, et qu'un toast est un état du parent, le cycle se referme sur lui-même :
// échec → toast → rendu → nouveau chargeur → effet rejoué → échec, sans fin, à la cadence de
// l'échec, et avec une sonde `/api/health` par tour. Elle s'emballait quand la base souffrait
// déjà.
//
// Le banc reproduit donc EXACTEMENT ce parent-là : deux rappels en fonctions nues, et un
// `toast` qui écrit dans son propre état. Si la stabilité redevient une affaire de convention
// tenue à l'étage du dessus, ce test le dit.

/** Ce que le banc a demandé au réseau, dans l'ordre. */
let calls: string[] = [];

/**
 * Le faux `fetch` ÉCHOUE — c'est la condition du cycle — mais se rend au bout d'un moment.
 *
 * Sans ce plafond, une régression ne ferait pas échouer ce test : elle le ferait TOURNER, et le
 * banc entier attendrait son délai de garde. On préfère une assertion qui tombe à un test qui
 * se fige.
 */
const PLAFOND = 25;

function fauxFetch(input: RequestInfo | URL) {
  const url = String(input);
  calls.push(url);
  if (calls.length > PLAFOND) {
    return Promise.resolve(
      new Response(JSON.stringify({ teams: [], fixtures: [], follows: [], pushReady: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
  return Promise.reject(new Error("réseau coupé"));
}

const compte = (fragment: string) => calls.filter((u) => u.includes(fragment)).length;

/** Laisse tourner les micro-tâches et les minuteurs courts, sans rien avancer artificiellement. */
async function respire(ms = 60) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

/**
 * Le parent tel qu'il était : deux rappels RECRÉÉS à chaque rendu, et un `toast` qui provoque
 * lui-même le rendu suivant. C'est la forme exacte de `page.tsx` avant correction.
 */
function BancInstable() {
  const [msgs, setMsgs] = useState<string[]>([]);
  const [tours, setTours] = useState(0);
  return (
    <>
      <span data-testid="toasts">{msgs.length}</span>
      {/* De quoi provoquer un rendu du parent SANS toucher à cet écran — l'équivalent d'une
          action menée ailleurs dans l'appli. */}
      <button data-testid="rendre" onClick={() => setTours((n) => n + 1)}>
        {tours}
      </button>
      <Interclub
        toast={(_type, msg) => setMsgs((x) => [...x, msg])}
        onExpired={(status) => status === 401}
      />
    </>
  );
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(fauxFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Interclub — indépendance au rendu du parent", () => {
  it("n'émet qu'UNE requête de liste quand tout échoue, si bavard que soit le parent", async () => {
    render(<BancInstable />);

    // Le chargement de montage a bien eu lieu…
    await waitFor(() => expect(compte("/api/interclub")).toBeGreaterThan(0));
    // …et il ne se rejoue pas, alors que le `catch` vient de toaster et donc de rendre le parent.
    await respire();

    expect(compte("/api/interclub?")).toBe(0); // pas de variante paramétrée : la liste est entière
    expect(calls.filter((u) => u.endsWith("/api/interclub")).length).toBe(1);
    expect(calls.length).toBeLessThan(PLAFOND);
  });

  it("ne recharge pas davantage quand le parent se rend pour une raison qui ne le regarde pas", async () => {
    const { getByTestId } = render(<BancInstable />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await respire();
    const apres1erChargement = calls.length;

    // Le parent se rend cinq fois de plus, sans que rien de cet écran n'ait changé — un toast
    // affiché ailleurs dans l'appli, puis sa disparition, produisent exactement cela.
    for (let i = 0; i < 5; i++) {
      fireEvent.click(getByTestId("rendre"));
      await respire(10);
    }
    // Le parent s'est bien rendu cinq fois : sans cela le test ne prouverait rien.
    expect(getByTestId("rendre").textContent).toBe("5");

    expect(calls.length).toBe(apres1erChargement);
  });
});
