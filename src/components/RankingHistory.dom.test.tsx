import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import { RankingHistory } from "@/components/RankingHistory";
import type { HistorySeries } from "@/lib/ranking-history";

// LA COURBE DE PROGRESSION, vue de l'écran.
//
// Ce fichier verrouille ce qu'un essai à la main ne verrait pas :
//   1. l'écran s'ouvre SUR SOI, et pas sur douze courbes emmêlées ;
//   2. la légende porte les CHIFFRES — c'est la version utilisable au doigt, et la version
//      lisible quand on ne voit pas le dessin ;
//   3. l'évolution dit le PROGRÈS, pas la variation brute : descendre au classement est un
//      « + », et c'est le piège que ce module existe pour éviter ;
//   4. le filtrage est LOCAL — cocher un joueur ne redemande rien au serveur.

function reponse(corps: unknown): Response {
  return { ok: true, status: 200, json: async () => corps } as unknown as Response;
}

async function souffle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

const MOIS = ["2026-01-05", "2026-02-02", "2026-03-02"];

function serie(
  id: string,
  name: string,
  vals: Array<{ mean: number | null; rangM: number | null } | null>,
): HistorySeries {
  return {
    id,
    kind: "member",
    name,
    team: null,
    points: vals.flatMap((v, i) =>
      v === null ? [] : [{ month: MOIS[i], clt: "5A", rang: null, rangM: v.rangM, mean: v.mean }],
    ),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function monte(series: HistorySeries[], meName?: string, months = MOIS) {
  fetchMock = vi.fn(async () => reponse({ months, series }));
  vi.stubGlobal("fetch", fetchMock);
  return render(<RankingHistory open onClose={() => {}} meName={meName} />);
}

/** La ligne de légende d'un joueur (celle qui porte les chiffres). */
function legende(nom: string) {
  const li = screen
    .getAllByRole("listitem")
    .find((el) => within(el).queryByText(nom) && el.querySelector(".rankhist-evo"));
  return li ?? null;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("RankingHistory", () => {
  it("ouvre sur SA propre courbe quand on reconnaît le joueur connecté", async () => {
    monte(
      [
        serie("u1", "Jean Dupont", [{ mean: 1000, rangM: 2300 }, null, { mean: 1100, rangM: 1800 }]),
        serie("u2", "Paul Martin", [{ mean: 900, rangM: 2600 }, null, null]),
      ],
      "Jean Dupont",
    );
    await souffle();
    expect(legende("Jean Dupont")).not.toBeNull();
    // Douze courbes par défaut seraient un plat de spaghettis : on ouvre sur soi.
    expect(legende("Paul Martin")).toBeNull();
  });

  it("à défaut de se reconnaître, ouvre sur les joueurs les mieux mesurés plutôt que sur du vide", async () => {
    monte([
      serie("u1", "Jean Dupont", [{ mean: 1000, rangM: 2300 }, null, null]),
      serie("u2", "Paul Martin", [
        { mean: 900, rangM: 2600 },
        { mean: 950, rangM: 2500 },
        { mean: 980, rangM: 2400 },
      ]),
    ]);
    await souffle();
    expect(legende("Paul Martin")).not.toBeNull();
  });

  it("la légende porte la dernière valeur ET l'évolution, en toutes lettres", async () => {
    monte([serie("u1", "Jean Dupont", [{ mean: 1000, rangM: 2300 }, null, { mean: 1128, rangM: 1800 }])], "Jean Dupont");
    await souffle();
    const li = legende("Jean Dupont");
    expect(li).not.toBeNull();
    expect(within(li as HTMLElement).getByText("1 128")).toBeTruthy();
    expect(within(li as HTMLElement).getByText("+128")).toBeTruthy();
  });

  // LE piège que tout ce module existe pour éviter : le rang baisse quand on progresse. Un
  // « −500 » devant la meilleure saison du club rendrait la colonne inutilisable.
  it("sur le RANG, descendre au classement s'affiche comme un progrès", async () => {
    monte([serie("u1", "Jean Dupont", [{ mean: 1000, rangM: 2300 }, null, { mean: 1128, rangM: 1800 }])], "Jean Dupont");
    await souffle();
    fireEvent.click(screen.getByRole("button", { name: "Rang" }));
    const li = legende("Jean Dupont") as HTMLElement;
    expect(within(li).getByText("+500")).toBeTruthy();
    expect(within(li).getByText("#1800")).toBeTruthy();
  });

  it("cocher un joueur trace sa courbe SANS rien redemander au serveur", async () => {
    monte(
      [
        serie("u1", "Jean Dupont", [{ mean: 1000, rangM: 2300 }, null, { mean: 1100, rangM: 1800 }]),
        serie("u2", "Paul Martin", [{ mean: 900, rangM: 2600 }, null, { mean: 950, rangM: 2500 }]),
      ],
      "Jean Dupont",
    );
    await souffle();
    expect(fetchMock).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("checkbox", { name: /Paul Martin/ }));
    expect(legende("Paul Martin")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("resserrer la plage de mois retire les mesures hors plage", async () => {
    monte(
      [
        serie("u1", "Jean Dupont", [
          { mean: 1000, rangM: 2300 },
          { mean: 1050, rangM: 2100 },
          { mean: 1100, rangM: 1800 },
        ]),
      ],
      "Jean Dupont",
    );
    await souffle();
    expect(within(legende("Jean Dupont") as HTMLElement).getByText("+100")).toBeTruthy();
    // On s'arrête en février : la dernière mesure visible devient 1 050.
    fireEvent.change(screen.getByLabelText("Jusqu'au mois"), { target: { value: "2026-02-02" } });
    const li = legende("Jean Dupont") as HTMLElement;
    expect(within(li).getByText("1 050")).toBeTruthy();
    expect(within(li).getByText("+50")).toBeTruthy();
  });

  it("une mesure identique d'un bout à l'autre affiche « ±0 », jamais « −0 »", async () => {
    // « −0 » se lit comme une baisse, et n'en est pas une.
    monte([serie("u1", "Jean Dupont", [{ mean: 1000, rangM: 2300 }, null, { mean: 1000, rangM: 2300 }])], "Jean Dupont");
    await souffle();
    expect(within(legende("Jean Dupont") as HTMLElement).getByText("±0")).toBeTruthy();
  });

  it("tout décocher n'affiche pas un graphique vide mais dit quoi faire", async () => {
    monte([serie("u1", "Jean Dupont", [{ mean: 1000, rangM: 2300 }, null, null])], "Jean Dupont");
    await souffle();
    fireEvent.click(screen.getByRole("checkbox", { name: /Jean Dupont/ }));
    expect(screen.getByText(/Choisis au moins un joueur/)).toBeTruthy();
  });

  // La question qui a motivé cet indice, posée mot pour mot devant l'écran : « pourquoi je n'ai
  // pas de données avant janvier ? ». Elle se pose ici, donc elle se répond ici.
  it("dit lui-même que l'historique n'a pas été rempli quand la plupart n'ont qu'une mesure", async () => {
    monte(
      [
        serie("u1", "Jean Dupont", [{ mean: 1000, rangM: 2300 }, { mean: 1050, rangM: 2200 }, { mean: 1100, rangM: 1800 }]),
        serie("u2", "Paul Martin", [null, null, { mean: 900, rangM: 2600 }]),
        serie("u3", "Luc Bernard", [null, null, { mean: 950, rangM: 2500 }]),
      ],
      "Jean Dupont",
    );
    await souffle();
    expect(screen.getByText(/2 joueurs sur 3/)).toBeTruthy();
    expect(screen.getByText(/Compléter l'historique/)).toBeTruthy();
  });

  it("se tait quand l'historique est correctement rempli", async () => {
    monte(
      [
        serie("u1", "Jean Dupont", [{ mean: 1000, rangM: 2300 }, { mean: 1050, rangM: 2200 }, null]),
        serie("u2", "Paul Martin", [{ mean: 900, rangM: 2600 }, { mean: 920, rangM: 2550 }, null]),
        // Un seul nouvel inscrit à une mesure unique est NORMAL, et ne doit rien déclencher.
        serie("u3", "Luc Bernard", [null, null, { mean: 950, rangM: 2500 }]),
      ],
      "Jean Dupont",
    );
    await souffle();
    expect(screen.queryByText(/une seule mesure/)).toBeNull();
  });

  it("historique vide → dit comment le remplir, sans graphique fantôme", async () => {
    monte([], undefined, []);
    await souffle();
    expect(screen.getByText(/Aucun historique pour le moment/)).toBeTruthy();
    expect(document.querySelector(".rankhist-graph")).toBeNull();
  });

  // Un mois non mesuré coupe le trait : relier janvier à mars par-dessus février dessinerait
  // une progression continue là où rien n'a été observé.
  it("ne relie pas deux mesures par-dessus un mois non mesuré", async () => {
    monte([serie("u1", "Jean Dupont", [{ mean: 1000, rangM: 2300 }, null, { mean: 1100, rangM: 1800 }])], "Jean Dupont");
    await souffle();
    const d = document.querySelector(".rankhist-trace")?.getAttribute("d") ?? "";
    expect(d).not.toContain("L");
    expect(d.match(/M/g)).toHaveLength(2);
  });
});
