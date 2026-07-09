import { describe, it, expect } from "vitest";
import { parseRankingFragment, parseLatestMonth } from "./client";

// Fragment réel capté sur squashnet.fr (POST ic_a=131079, name=courtaut) : sélecteur de mois
// + bloc résultats. La 1re ligne est authentique ; la 2e est synthétique (homonyme dans un
// autre club) pour couvrir le multi-résultats et le filtrage par club côté « matching ».
const MONTH_SELECT = `<select id='month' name='month' class='form-control'><option value='2026-07-07' selected='selected'>Juillet 2026</option>
<option value='2026-06-02'>Juin 2026</option>
<option value='2026-05-05'>Mai 2026</option></select>`;

const ROW_JEROME = `<div class='row ranking'><div class='div-rank-gender'><span class='material-icons'>male</span></div>
<div class='div-rank-rangM'><span>3603</span></div>
<div class='div-rank-name'><span>COURTAUT JEROME</span></div>
<div class='div-rank-rang'><span>3184</span></div>
<div class='div-rank-clt'><span><span>5A</span></span></div>
<div class='div-rank-mean'><span>3 832.17</span></div>
<div class='div-rank-ligue'><span>IDF</span></div>
<div class='div-rank-lic'><span>0124215</span></div>
<div class='div-rank-asso'><span title='Squash de l yvette'>Squash de l yvette</span></div>
<div class='div-rank-cat'><span>+55</span></div>
</div>`;

const ROW_MARIE = `<div class='row ranking'><div class='div-rank-gender'><span class='material-icons'>female</span></div>
<div class='div-rank-rangM'><span>12</span></div>
<div class='div-rank-name'><span>COURTAUT MARIE</span></div>
<div class='div-rank-rang'><span>44</span></div>
<div class='div-rank-clt'><span><span>2C</span></span></div>
<div class='div-rank-mean'><span>7 210.00</span></div>
<div class='div-rank-ligue'><span>BRE</span></div>
<div class='div-rank-lic'><span>0999888</span></div>
<div class='div-rank-asso'><span title='Squash Club de Rennes'>Squash Club de Rennes</span></div>
<div class='div-rank-cat'><span>Senior</span></div>
</div>`;

const wrap = (rows: string) =>
  `<div id='div_criteria'>${MONTH_SELECT}</div>
<div id='div_results' class='div-results-ranking'><div class='mx-0 table'><div id='results' class='results'><div class='ranking ranking-head'><div class='div-rank-name'><span>Joueur</span></div></div>
${rows}
</div></div></div>
<div class='div-pages'><a href='#'>1</a></div>`;

describe("parseLatestMonth", () => {
  it("renvoie la 1re option du select mois (période la plus récente)", () => {
    expect(parseLatestMonth(wrap(ROW_JEROME))).toBe("2026-07-07");
  });
  it("null si aucun select mois", () => {
    expect(parseLatestMonth("<div>rien</div>")).toBeNull();
  });
});

describe("parseRankingFragment", () => {
  it("extrait tous les champs d'une ligne réelle (spans imbriqués, title)", () => {
    const rows = parseRankingFragment(wrap(ROW_JEROME));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      name: "COURTAUT JEROME",
      clt: "5A", // <span><span>5A</span></span> → texte seul
      club: "Squash de l yvette", // title + texte → texte
      licence: "0124215",
      ligue: "IDF",
      cat: "+55",
      gender: "male",
      rang: "3184", // ne capte pas rangM (3603)
      rangM: "3603",
      mean: "3 832.17", // espace insécable normalisé
    });
  });

  it("gère plusieurs lignes (homonymes) en conservant leurs clubs respectifs", () => {
    const rows = parseRankingFragment(wrap(`${ROW_JEROME}\n${ROW_MARIE}`));
    expect(rows.map((r) => [r.name, r.club, r.clt])).toEqual([
      ["COURTAUT JEROME", "Squash de l yvette", "5A"],
      ["COURTAUT MARIE", "Squash Club de Rennes", "2C"],
    ]);
  });

  it("aucun résultat → tableau vide", () => {
    expect(parseRankingFragment(wrap(""))).toEqual([]);
  });

  it("n'invente rien hors de la zone résultats", () => {
    // Le select mois contient des <option> mais aucune ligne 'row ranking'.
    expect(parseRankingFragment(MONTH_SELECT)).toEqual([]);
  });
});
