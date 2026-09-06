import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// LA DIFFÉRENCE ENTRE « COUPÉ » ET « PAS ENCORE SU ».
//
// En production, toutes les `NEXT_PUBLIC_FEATURE_*` valent "0" : ce sont les overrides posés en
// base, servis par /api/features, qui allument Frais, Tournoi et Interclub. Le premier rendu de
// l'appli lit donc `false` partout — et ce `false` ne veut PAS dire « l'admin a coupé ». Qui
// prend une décision irréversible dessus (fermer une vue, écraser l'état persisté) agit sur une
// valeur fausse. C'est exactement ce qui renvoyait le membre sur la réservation de créneaux à
// chaque rafraîchissement en prod, et jamais sur Recette, où l'env allume tout.
//
// Ce que ces tests tiennent : `useFeaturesReady()` est faux tant que la réponse n'est pas là, et
// vrai ENSUITE — y compris quand elle n'arrive jamais, cas où les défauts d'env sont la réponse
// définitive et non une étape.

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

vi.mock("@/lib/features", async () => {
  const reel = await vi.importActual<typeof import("@/lib/features")>("@/lib/features");
  // On force l'ENV « tout OFF » de la production, quel que soit l'environnement de test.
  const env = Object.fromEntries(reel.FEATURE_KEYS.map((k) => [k, false]));
  return { ...reel, ENV_FEATURES: env };
});

import FeatureProvider, { useFeatures, useFeaturesReady } from "@/components/FeatureProvider";

function Sonde() {
  const { tricount } = useFeatures();
  const ready = useFeaturesReady();
  return <p>{`${ready ? "su" : "inconnu"}/${tricount ? "on" : "off"}`}</p>;
}

/** Une réponse qu'on délivre à la main, pour observer l'instant d'AVANT. */
function reponseDifferee() {
  let livrer: (v: unknown) => void = () => {};
  const promesse = new Promise((r) => (livrer = r));
  return { promesse, livrer: () => livrer({ ok: true, json: async () => ({ features: { tricount: true } }) }) };
}

describe("FeatureProvider — savoir avant d'agir", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reste « inconnu » tant que /api/features n'a pas répondu, puis livre l'override", async () => {
    const r = reponseDifferee();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockReturnValue(r.promesse);

    render(
      <FeatureProvider>
        <Sonde />
      </FeatureProvider>,
    );

    // L'instant du défaut : `tricount` est déjà à `off`, mais rien ne l'a encore confirmé.
    expect(screen.getByText("inconnu/off")).toBeDefined();

    r.livrer();
    await waitFor(() => expect(screen.getByText("su/on")).toBeDefined());
  });

  it("devient « su » même quand la requête échoue : l'env est alors la réponse, pas une étape", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("hors ligne"));

    render(
      <FeatureProvider>
        <Sonde />
      </FeatureProvider>,
    );

    // Sans ça, un membre hors ligne resterait bloqué dans l'attente : `ready` ne viendrait
    // jamais, et tout ce qui l'attend serait gelé pour de bon.
    await waitFor(() => expect(screen.getByText("su/off")).toBeDefined());
  });

  it("devient « su » sur une réponse en erreur (500) : on garde l'env et on avance", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false });

    render(
      <FeatureProvider>
        <Sonde />
      </FeatureProvider>,
    );

    await waitFor(() => expect(screen.getByText("su/off")).toBeDefined());
  });
});
