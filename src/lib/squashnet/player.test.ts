import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PlayerUnreadableError, estFicheJoueur, parsePlayer, splitTieLabel } from "./player";

// ============================================================================
//  LA VRAIE FICHE D'UN JOUEUR — KADI RAFIK (Squash in Issy), regiid 644801.
//
//  Fragment capté tel quel le 2026-10-18 (`ic_a=393477&regiid=644801`). Deux
//  matchs, tous deux gagnés — les mêmes que l'appli Squash App affiche.
// ============================================================================

const html = readFileSync(join(__dirname, "__fixtures__", "joueur-2027-644801-fiche.html"), "utf8");

describe("parsePlayer — la fiche réelle de KADI RAFIK", () => {
  const p = parsePlayer(html, "644801");

  it("lit l'identité et le classement", () => {
    expect(p).toMatchObject({
      regiid: "644801",
      name: "KADI RAFIK",
      licence: "0140024",
      category: "+45",
      clt: "5B",
      rang: 4086,
      rangM: 4976,
    });
  });

  it("lit ses deux matchs, de son point de vue", () => {
    expect(p.matches).toEqual([
      {
        tie: "Verrieres 5-Squash in Issy",
        date: "2026-10-08",
        time: "20:00",
        clt: "5B",
        rang: 4086,
        rangM: 4976,
        opponent: { name: "DETRY XAVIER", regiid: "647808", clt: "5B", rang: 3489, rangM: 4120 },
        result: "won",
        // Son score en premier : la feuille de poule écrit « 5-11 8-11 15-13 7-11 » (receveur
        // d'abord), la fiche du joueur l'inverse.
        score: "11-5 11-8 13-15 11-7",
      },
      {
        tie: "Verrieres 4-Squash in Issy",
        date: "2026-10-15",
        time: "20:00",
        clt: "5B",
        rang: 4086,
        rangM: 4976,
        opponent: { name: "BOUGARDIER FRANCK", regiid: "644862", clt: "NC", rang: 9373, rangM: 9373 },
        result: "won",
        score: "11-8 11-6 11-5",
      },
    ]);
  });

  it("garde une forme relisable depuis la base", () => {
    expect(estFicheJoueur(JSON.parse(JSON.stringify(p)))).toBe(true);
    expect(estFicheJoueur({ regiid: "1" })).toBe(false);
  });
});

describe("parsePlayer — vide, illisible, ou un autre joueur", () => {
  it("jette si le fragment désigne un AUTRE joueur", () => {
    expect(() => parsePlayer(html, "123")).toThrow(PlayerUnreadableError);
  });

  it("jette si le tableau des résultats manque", () => {
    expect(() => parsePlayer(html.replace("table_results", "autre"), "644801")).toThrow(
      PlayerUnreadableError,
    );
  });

  it("un tableau sans ligne : aucun match, pas une erreur", () => {
    const vide = html.replace(/<tbody>(?:(?!<tbody>)[\s\S])*?Verrieres 5[\s\S]*?<\/tbody>/, "<tbody></tbody>");
    expect(parsePlayer(vide, "644801").matches).toEqual([]);
  });
});

describe("splitTieLabel — couper l'intitulé sur un nom connu, jamais au hasard", () => {
  const noms = ["Verrieres 5", "Verrieres 4", "Squash in Issy", "Squash de l'Yvette 1"];

  it("coupe sur deux noms connus, dans l'ordre publié", () => {
    expect(splitTieLabel("Verrieres 5-Squash in Issy", noms)).toEqual(["Verrieres 5", "Squash in Issy"]);
    expect(splitTieLabel("Squash in Issy - Verrieres 4", noms)).toEqual(["Squash in Issy", "Verrieres 4"]);
  });

  it("ne devine pas : un nom inconnu d'un côté, et rien n'est coupé", () => {
    expect(splitTieLabel("Verrieres 5-Montigny 3", noms)).toBeNull();
    expect(splitTieLabel("Verrieres 51-Squash in Issy", noms)).toBeNull();
  });
});
