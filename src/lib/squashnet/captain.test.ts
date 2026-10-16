import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FormulaireIlisible,
  construireEnvoi,
  ecartsApresEnvoi,
  empreinteEnvoi,
  nomOption,
  parseDetailRencontre,
  parseFormulaireSaisie,
  parseRencontresCapitaine,
  raisonFermeture,
  type FormulaireSaisie,
} from "./captain";
import { rapport1893481 } from "./__fixtures__/rapport-2027-1893481";

// ============================================================================
//  L'ESPACE CAPITAINE SQUASHNET — formulaire de saisie, détail, liste.
//
//  Les captures viennent de la page capitaine de Yvette 2, relevée le
//  16/10/2026 (rencontre 1893481 contre Verrieres 3, J1 1893544 contre
//  Verrieres 4 pour le détail). Le jeton anti-falsification en est retiré.
// ============================================================================

const fixture = (nom: string) => readFileSync(join(__dirname, "__fixtures__", nom), "utf8");
const FORMULAIRE = fixture("capitaine-2027-1893481-saisie.html");
const DETAIL = fixture("capitaine-2027-1893544-detail.html");
const RENCONTRES = fixture("capitaine-2027-176168-rencontres.html");

const YVETTE2 = "176168";
const VERRIERES3 = "176172";

describe("parseFormulaireSaisie — le formulaire réel de Yvette 2 – Verrieres 3", () => {
  const f = parseFormulaireSaisie(FORMULAIRE);

  it("lit les champs cachés, SANS le jeton — il appartient à la session", () => {
    expect(f.caches).toEqual({ ic_a: "330250", ic_ajax: "1", tieid: "1893481", roundid: "383987" });
  });

  it("reconnaît les deux équipes par le teamid de leur case « Forfait », recevant d'abord", () => {
    expect(f.recevant).toEqual({ nom: "Squash de l'Yvette 2 (YVETTE2)", teamId: YVETTE2 });
    expect(f.visiteur).toEqual({ nom: "Verrieres 3 (VERR3)", teamId: VERRIERES3 });
  });

  it("lit les quatre simples, leur ordre et la composition présélectionnée", () => {
    expect(f.simples.map((s) => [s.ordre, s.mid, s.recevant.choisi, s.visiteur.choisi])).toEqual([
      [1, "2509582", "648361", "648301"],
      [2, "2509583", "648365", "647414"],
      [3, "2509584", "648360", "647419"],
      [4, "2509585", "651929", "647417"],
    ]);
  });

  it("lit les joueurs sans leur préfixe de classement, et repère les deux « WO »", () => {
    const s = f.simples[0];
    expect(s.recevant.champ).toBe("h1_2509582");
    expect(s.recevant.options).toHaveLength(12);
    expect(s.visiteur.options).toHaveLength(11);
    expect(s.recevant.options.filter((o) => o.wo)).toHaveLength(2);
    expect(s.recevant.options).toContainEqual({ id: "648364", nom: "GIRARD PIERRE-MARIE", wo: false });
  });

  it("lit les cinq paires de cases de points", () => {
    expect(f.simples[3].jeux).toEqual([1, 2, 3, 4, 5].map((n) => [`sch${n}_2509585`, `scv${n}_2509585`]));
  });

  it("JETTE quand la réponse n'est pas un formulaire de saisie", () => {
    expect(() => parseFormulaireSaisie("<div>Non joué</div>")).toThrow(FormulaireIlisible);
  });

  it("JETTE quand une ligne a perdu ses listes de joueurs", () => {
    const abime = FORMULAIRE.replace(/name="v1_2509583"/, 'name="autre"');
    expect(() => parseFormulaireSaisie(abime)).toThrow(FormulaireIlisible);
  });
});

describe("nomOption", () => {
  it("garde le trait d'union d'un prénom composé", () => {
    expect(nomOption("9373 - NC - 9373 - GIRARD PIERRE-MARIE")).toBe("GIRARD PIERRE-MARIE");
  });
});

describe("construireEnvoi", () => {
  const form = () => parseFormulaireSaisie(FORMULAIRE);

  it("traduit le rapport en champs du formulaire, jeux du point de vue du recevant", () => {
    const r = construireEnvoi(form(), rapport1893481(), YVETTE2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.envoi.champs;
    expect(r.envoi.nousRecevons).toBe(true);
    expect([c.h1_2509582, c.v1_2509582, c.sch1_2509582, c.scv1_2509582]).toEqual([
      "648361",
      "648301",
      "9",
      "11",
    ]);
    // Un simple en quatre jeux laisse la cinquième case VIDE, comme le ferait le formulaire.
    expect([c.sch4_2509585, c.scv4_2509585, c.sch5_2509585, c.scv5_2509585]).toEqual(["2", "11", "", ""]);
    expect(c).toMatchObject({ ic_a: "330250", tieid: "1893481", roundid: "383987", msg: "" });
    expect(c).not.toHaveProperty("ic_csrf");
    // Aucune case cochée : ni forfait, ni abandon, ni WO.
    expect(Object.keys(c).filter((k) => /^(woh|wov|abh|abv)/.test(k))).toEqual([]);
    expect(r.envoi.lignes[3]).toEqual({
      ordre: 4,
      recevant: "VICART DAMIEN",
      visiteur: "DOUSSERON PASCAL",
      jeux: ["11-8", "0-11", "3-11", "2-11"],
    });
  });

  it("INVERSE colonnes et jeux quand nous sommes le visiteur — « home » du rapport, c'est nous", () => {
    // Le même formulaire vu par Verrieres 3 : leur rapport met LEURS joueurs en `home`, et leurs
    // jeux de leur point de vue. Ce qui part doit être exactement la même feuille.
    const nous = rapport1893481();
    const eux = {
      ...nous,
      players: nous.players.map((p) => ({ ...p, side: p.side === "home" ? ("away" as const) : ("home" as const) })),
      scores: nous.scores.map((s) => ({ ...s, games: s.games.map((g) => ({ home: g.away, away: g.home })) })),
    };
    const a = construireEnvoi(form(), nous, YVETTE2);
    const b = construireEnvoi(form(), eux, VERRIERES3);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.envoi.nousRecevons).toBe(false);
    expect(b.envoi.champs).toEqual(a.envoi.champs);
    expect(empreinteEnvoi(b.envoi.champs)).toBe(empreinteEnvoi(a.envoi.champs));
  });

  it("refuse un formulaire qui n'est pas celui de notre équipe", () => {
    const r = construireEnvoi(form(), rapport1893481(), "999999");
    expect(r).toEqual({ ok: false, problemes: [expect.stringMatching(/aucune des deux n'est notre équipe/)] });
  });

  it("refuse un joueur que la vérification n'a pas identifié", () => {
    const rap = rapport1893481();
    rap.players[2] = { ...rap.players[2], fedName: null, name: "Jeronimo" };
    const r = construireEnvoi(form(), rap, YVETTE2);
    expect(r).toEqual({ ok: false, problemes: [expect.stringMatching(/^Simple n° 2 : Jeronimo n'est pas identifié/)] });
  });

  it("refuse un joueur absent de la liste squashnet, plutôt que de prendre le présélectionné", () => {
    const rap = rapport1893481();
    rap.players[1] = { ...rap.players[1], fedName: "INCONNU JEAN" };
    const r = construireEnvoi(form(), rap, YVETTE2);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problemes).toEqual([
      "Simple n° 1 : INCONNU JEAN ne figure pas parmi les joueurs de Verrieres 3 (VERR3) sur squashnet.",
    ]);
  });

  it("refuse deux options homonymes plutôt que de choisir au hasard", () => {
    const f: FormulaireSaisie = form();
    f.simples[0].visiteur.options.push({ id: "1", nom: "GUILLAUME THUILLIER", wo: false });
    const r = construireEnvoi(f, rapport1893481(), YVETTE2);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problemes[0]).toMatch(/plusieurs joueurs de Verrieres 3 \(VERR3\) s'appellent THUILLIER GUILLAUME/);
  });

  it("refuse un score incohérent et un nombre de simples qui diffère", () => {
    const rap = rapport1893481();
    rap.scores[0] = { ...rap.scores[0], ok: false, problem: "aucun vainqueur" };
    rap.scores.pop();
    const r = construireEnvoi(form(), rap, YVETTE2);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problemes).toEqual([
      "squashnet attend 4 simples, la rencontre en compte 3.",
      "Simple n° 1 : aucun vainqueur.",
    ]);
  });
});

describe("empreinteEnvoi", () => {
  it("ne dépend pas de l'ordre des champs, et bouge avec la moindre valeur", () => {
    expect(empreinteEnvoi({ a: "1", b: "2" })).toBe(empreinteEnvoi({ b: "2", a: "1" }));
    expect(empreinteEnvoi({ a: "1", b: "2" })).not.toBe(empreinteEnvoi({ a: "1", b: "3" }));
  });
});

describe("parseDetailRencontre — le détail réel de la J1 contre Verrieres 4", () => {
  const d = parseDetailRencontre(DETAIL);

  it("dit qui a saisi et qui a confirmé", () => {
    expect(d.saisiePar).toBe("PLENAT THOMAS");
    expect(d.confirmeePar).toBe("LAUNAY EMMANUEL");
  });

  it("lit chaque simple, recevant d'abord, jeux de son point de vue", () => {
    expect(d.lignes).toHaveLength(4);
    expect(d.lignes[0]).toEqual({
      ordre: 1,
      recevant: "FAUVEAU SERGE",
      visiteur: "PEGOT BRUCE",
      jeux: ["8-11", "11-2", "11-7", "11-7"],
    });
    expect(d.lignes[2].visiteur).toBe("GIRARD PIERRE-MARIE");
  });
});

describe("ecartsApresEnvoi", () => {
  const envoi = {
    champs: {},
    nousRecevons: false,
    lignes: [
      { ordre: 1, recevant: "FAUVEAU SERGE", visiteur: "PEGOT BRUCE", jeux: ["8-11", "11-2", "11-7", "11-7"] },
      { ordre: 2, recevant: "FOULON YANN", visiteur: "WANLIN ERIC", jeux: ["4-11", "12-14", "10-12"] },
    ],
  };

  it("ne dit rien quand squashnet affiche ce qui est parti", () => {
    expect(ecartsApresEnvoi(envoi, parseDetailRencontre(DETAIL))).toEqual([]);
  });

  it("nomme chaque écart, joueur comme jeux", () => {
    const faux = { ...envoi, lignes: [{ ...envoi.lignes[1], visiteur: "GIRARD PIERRE-MARIE", jeux: ["11-4"] }] };
    expect(ecartsApresEnvoi(faux, parseDetailRencontre(DETAIL))).toEqual([
      "Simple n° 2 : squashnet affiche FOULON YANN – WANLIN ERIC, on a envoyé FOULON YANN – GIRARD PIERRE-MARIE.",
      "Simple n° 2 : squashnet affiche 4-11 12-14 10-12, on a envoyé 11-4.",
    ]);
  });

  it("signale un simple absent du détail — une saisie qui n'a pas pris", () => {
    expect(ecartsApresEnvoi(envoi, { saisiePar: null, confirmeePar: null, lignes: [] })).toHaveLength(2);
  });
});

describe("parseRencontresCapitaine — la liste réelle de Yvette 2", () => {
  const l = parseRencontresCapitaine(RENCONTRES);

  it("lit l'état, l'identifiant et l'ouverture de la saisie de chaque rencontre", () => {
    expect(l).toEqual([
      { tieid: "1893544", date: "2026-10-08", adversaire: "Verrieres 4", etat: "validee", saisieOuverte: false },
      { tieid: "1893481", date: "2026-10-15", adversaire: "Verrieres 3", etat: "non-jouee", saisieOuverte: true },
      { tieid: "1893455", date: "2026-11-05", adversaire: "CAL Squash", etat: "non-jouee", saisieOuverte: false },
    ]);
  });

  it("explique pourquoi la saisie n'est pas proposée", () => {
    expect(raisonFermeture(l[0])).toMatch(/déjà validée/);
    expect(raisonFermeture(l[2])).toMatch(/le jour de la rencontre, pour 5 jours/);
    expect(raisonFermeture({ ...l[1], etat: "saisie" })).toMatch(/attend la confirmation/);
    expect(raisonFermeture(undefined)).toMatch(/n'apparaît pas/);
  });
});
