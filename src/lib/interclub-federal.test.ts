import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTeamRoster, type TeamRoster, type RosterPlayer } from "./squashnet/roster";
import {
  absentsDuRoster,
  cltUtile,
  doublonsAppli,
  rangMUtile,
  rapprocherRoster,
  type JoueurAppli,
} from "./interclub-federal";

// ============================================================================
//  UNE VRAIE FICHE D'ÉQUIPE, AVEC DE VRAIS NC.
//
//  La fixture est le fragment RÉEL de Verrieres 4 (`teamid=176173`), capté le
//  2026-09-24 : POST index.php ic_a=393480. Huit inscrits, dont UN SEUL classé.
//  C'est exactement la population que le classement national ne sait pas rendre,
//  et donc la seule sur laquelle ce module prouve quelque chose.
// ============================================================================

const FICHE: TeamRoster = parseTeamRoster(
  readFileSync(join(__dirname, "squashnet", "__fixtures__", "equipe-2027-176173-roster-nc.html"), "utf8"),
  "176173",
);

const ligne = (nom: string): RosterPlayer => {
  const p = FICHE.players.find((x) => x.name === nom);
  if (!p) throw new Error(`ligne absente de la fixture : ${nom}`);
  return p;
};

const joueur = (o: Partial<JoueurAppli> & { name: string }): JoueurAppli => ({
  kind: "member",
  id: o.name,
  licence: null,
  ...o,
});

/** Une fiche minimale, pour les cas que la fixture réelle ne contient pas. */
const ficheDe = (players: RosterPlayer[]): TeamRoster => ({ ...FICHE, players });

describe("la fiche fédérale, telle qu'elle est publiée", () => {
  it("porte huit inscrits, sept NC et un seul classé", () => {
    // Le rapport de force que tout ce module existe pour traiter : le classement national ne
    // connaît que le 4D, et laisserait les sept autres sans rien.
    expect(FICHE.players).toHaveLength(8);
    expect(FICHE.players.filter((p) => p.clt === "NC")).toHaveLength(7);
    expect(ligne("LAUNAY EMMANUEL").clt).toBe("4D");
  });

  it("donne une licence à TOUT LE MONDE, NC compris", () => {
    // C'est le fait qui rend ce module possible : la clé fédérale existe même pour un joueur
    // dont le classement national n'a aucune ligne.
    expect(FICHE.players.every((p) => (p.licence ?? "").trim() !== "")).toBe(true);
  });
});

describe("cltUtile / rangMUtile — ce qu'on retient d'une ligne", () => {
  it("garde le classement d'un joueur classé, et son rang", () => {
    const p = ligne("LAUNAY EMMANUEL");
    expect(cltUtile(p)).toBe("4D");
    expect(rangMUtile(p)).toBe(2296);
  });

  it("⚠️ NE RECOPIE JAMAIS la sentinelle 9311 d'un NC", () => {
    // Les sept NC de cette fiche portent tous `rang: 9311, rangM: 9311`, à la même seconde. Ce
    // n'est pas un rang, c'est « non classé ». L'écrire placerait ces joueurs au 9311e rang
    // national — un nombre qui a l'air d'un fait, qui se trie, et qui s'afficherait.
    for (const p of FICHE.players.filter((x) => x.clt === "NC")) {
      expect(p.rangM).toBe(9311);
      expect(cltUtile(p)).toBe("NC");
      expect(rangMUtile(p)).toBeNull();
    }
  });

  it("refuse un classement que l'ordre des simples ne sait pas comparer", () => {
    // « 6A » et « R1 » n'existent pas. Les recopier rendrait le joueur inalignable un soir de
    // rencontre, avec un message opaque : mieux vaut ne rien savoir, l'admin corrige alors.
    for (const clt of ["6A", "R1", "4E", "N"]) {
      expect(cltUtile({ ...ligne("LAUNAY EMMANUEL"), clt })).toBeNull();
    }
    expect(cltUtile({ ...ligne("LAUNAY EMMANUEL"), clt: null })).toBeNull();
  });

  it("un classement inconnu ne rend pas non plus de rang", () => {
    // Sans classement, le joueur n'est pas ordonnable : un rang seul ne ferait que le croire.
    expect(rangMUtile({ ...ligne("LAUNAY EMMANUEL"), clt: "6A" })).toBeNull();
  });

  it("accepte la casse et les espaces de la fédération", () => {
    expect(cltUtile({ ...ligne("LAUNAY EMMANUEL"), clt: " 4d " })).toBe("4D");
  });
});

describe("rapprocherRoster — la licence d'abord", () => {
  it("rapproche par LICENCE, même si le nom ne colle pas du tout", () => {
    // C'est tout l'intérêt de la clé fédérale : elle survit à une orthographe divergente, à une
    // inversion, à un nom de jeune fille.
    const moi = joueur({ name: "Quelqu'un d'Autre", id: "u1", licence: "1463138W" });
    const [l] = rapprocherRoster(ficheDe([ligne("LAUNAY EMMANUEL")]), [moi]);
    expect(l.appariement).toEqual({ statut: "lie", joueur: moi, par: "licence" });
  });

  it("compare les licences sans se soucier de la casse ni des espaces", () => {
    const moi = joueur({ name: "X", id: "u1", licence: " 1463138w " });
    const [l] = rapprocherRoster(ficheDe([ligne("LAUNAY EMMANUEL")]), [moi]);
    expect(l.appariement.statut).toBe("lie");
  });

  it("deux joueurs de l'appli sur la MÊME licence : on ne tranche pas", () => {
    // L'incohérence est dans nos données, pas chez la fédération. Trancher au hasard poserait un
    // classement sur la mauvaise personne, et personne ne va le vérifier.
    const a = joueur({ name: "A", id: "u1", licence: "1463138W" });
    const b = joueur({ name: "B", id: "u2", licence: "1463138W" });
    const [l] = rapprocherRoster(ficheDe([ligne("LAUNAY EMMANUEL")]), [a, b]);
    expect(l.appariement).toEqual({ statut: "ambigu", candidats: [a, b] });
  });
});

describe("rapprocherRoster — le nom en repli", () => {
  it("⚠️ rapproche malgré l'ORDRE INVERSÉ des mots", () => {
    // La fédération écrit « DOXAT ERIC », l'appli « Éric Doxat ». Sans le pliage de `nameKey`,
    // aucune ligne ne se rapprocherait jamais — et c'est le cas le plus banal du lot.
    const eric = joueur({ name: "Éric Doxat", id: "u9" });
    const [l] = rapprocherRoster(ficheDe([ligne("DOXAT ERIC")]), [eric]);
    expect(l.appariement).toEqual({ statut: "lie", joueur: eric, par: "nom" });
  });

  it("deux homonymes dans l'équipe : ambigu, et les deux sont proposés", () => {
    const a = joueur({ name: "Eric Doxat", id: "u1" });
    const b = joueur({ name: "Doxat Eric", id: "u2", kind: "guest" });
    const [l] = rapprocherRoster(ficheDe([ligne("DOXAT ERIC")]), [a, b]);
    expect(l.appariement).toEqual({ statut: "ambigu", candidats: [a, b] });
  });

  it("⚠️ une licence CONNUE et DIFFÉRENTE disqualifie, si parfait que soit le nom", () => {
    // Deux licenciés homonymes. Celui qui porte déjà une licence n'est plus candidat : la
    // fédération a dit qu'il est quelqu'un d'autre. C'est ce qui fait que le rapprochement se
    // resserre à mesure qu'on le fait.
    const autre = joueur({ name: "Eric Doxat", id: "u1", licence: "0000000" });
    const bon = joueur({ name: "Eric Doxat", id: "u2" });
    const [l] = rapprocherRoster(ficheDe([ligne("DOXAT ERIC")]), [autre, bon]);
    expect(l.appariement).toEqual({ statut: "lie", joueur: bon, par: "nom" });
  });

  it("⚠️ DEUX LIGNES qui visent le même joueur n'en apparient AUCUNE", () => {
    // Deux licenciés homonymes chez la fédération, un seul compte dans l'appli. Chaque ligne
    // prise isolément conclurait « lié », et le même joueur serait apparié deux fois — donc
    // aligné deux fois, avec deux classements. L'ambiguïté se lit dans les DEUX sens.
    const seul = joueur({ name: "Eric Doxat", id: "u1" });
    const jumeau: RosterPlayer = { ...ligne("DOXAT ERIC"), licence: "9999999X" };
    const lignes = rapprocherRoster(ficheDe([ligne("DOXAT ERIC"), jumeau]), [seul]);
    expect(lignes.map((l) => l.appariement.statut)).toEqual(["ambigu", "ambigu"]);
  });

  it("mais une LICENCE reste une preuve, même quand une autre ligne convoite le nom", () => {
    const seul = joueur({ name: "Eric Doxat", id: "u1", licence: "1528030W" });
    const jumeau: RosterPlayer = { ...ligne("DOXAT ERIC"), licence: "9999999X" };
    const lignes = rapprocherRoster(ficheDe([ligne("DOXAT ERIC"), jumeau]), [seul]);
    expect(lignes[0].appariement).toEqual({ statut: "lie", joueur: seul, par: "licence" });
    expect(lignes[1].appariement.statut).toBe("inconnu");
  });

  it("personne ne colle : « inconnu », qui est le cas normal d'un début de saison", () => {
    const [l] = rapprocherRoster(ficheDe([ligne("FOULON YANN")]), [joueur({ name: "Jean Dupont" })]);
    expect(l.appariement).toEqual({ statut: "inconnu" });
  });

  it("apparie la fiche entière : sept inconnus pour un membre reconnu", () => {
    const lignes = rapprocherRoster(FICHE, [joueur({ name: "Emmanuel Launay", id: "u1" })]);
    expect(lignes.filter((l) => l.appariement.statut === "lie")).toHaveLength(1);
    expect(lignes.filter((l) => l.appariement.statut === "inconnu")).toHaveLength(7);
  });
});

describe("absentsDuRoster — l'oubli de déclaration", () => {
  it("signale un joueur de l'appli que la fédération n'a pas inscrit", () => {
    // Ce n'est pas un défaut de rapprochement : c'est un joueur qui sera refusé sur la feuille
    // de match, et le seul moment où on peut encore le rattraper est maintenant.
    const oublie = joueur({ name: "Jean Dupont", id: "u1" });
    expect(absentsDuRoster(FICHE, [joueur({ name: "Emmanuel Launay" }), oublie])).toEqual([oublie]);
  });

  it("⚠️ une licence connue et absente de la fiche tranche SEULE", () => {
    // Repasser par le nom rattraperait un homonyme inscrit, lui, et masquerait précisément
    // l'oubli qu'on cherche à signaler.
    const homonyme = joueur({ name: "Eric Doxat", id: "u1", licence: "9999999X" });
    expect(absentsDuRoster(FICHE, [homonyme])).toEqual([homonyme]);
  });

  it("une licence connue et présente suffit, quel que soit le nom", () => {
    const marie = joueur({ name: "Nom De Jeune Fille", id: "u1", licence: "1463138W" });
    expect(absentsDuRoster(FICHE, [marie])).toEqual([]);
  });

  it("sans licence, le nom décide — ordre des mots compris", () => {
    expect(absentsDuRoster(FICHE, [joueur({ name: "Yann Foulon" })])).toEqual([]);
  });
});

describe("doublonsAppli — l'invité qui vient de se créer un compte", () => {
  const membre = (o: Partial<JoueurAppli> & { name: string }) => joueur({ kind: "member", ...o });
  const invite = (o: Partial<JoueurAppli> & { name: string }) =>
    joueur({ kind: "guest", id: `g-${o.name}`, ...o });

  it("⚠️ repère la même personne des DEUX CÔTÉS du roster", () => {
    // Le cycle normal : on inscrit un invité depuis la fiche fédérale, il ouvre l'appli des
    // mois plus tard, un admin le rattache à son équipe — et l'équipe le porte deux fois. Le
    // menu de composition le propose deux fois, avec deux classements qui peuvent diverger.
    const m = membre({ name: "Eric Doxat", id: "u1" });
    const g = invite({ name: "DOXAT ERIC", licence: "1528030W" });
    expect(doublonsAppli([m, g])).toEqual([{ membre: m, invite: g, par: "nom" }]);
  });

  it("préfère la LICENCE au nom, et s'en contente", () => {
    const m = membre({ name: "Nom De Jeune Fille", id: "u1", licence: "1528030W" });
    const g = invite({ name: "DOXAT ERIC", licence: "1528030w" });
    expect(doublonsAppli([m, g])).toEqual([{ membre: m, invite: g, par: "licence" }]);
  });

  it("deux licences CONNUES et différentes : deux personnes, quel que soit le nom", () => {
    // C'est le cas des deux frères. Fusionner effacerait un joueur du roster, et son historique
    // partirait avec l'invité supprimé.
    const m = membre({ name: "Eric Doxat", id: "u1", licence: "1111111" });
    const g = invite({ name: "Eric Doxat", licence: "2222222" });
    expect(doublonsAppli([m, g])).toEqual([]);
  });

  it("deux membres homonymes : on ne conclut rien", () => {
    // Le nom ne désigne plus une personne. Choisir au hasard fondrait l'invité dans le mauvais
    // compte — et la promotion supprime l'invité, donc l'erreur ne se rattrape pas.
    const a = membre({ name: "Eric Doxat", id: "u1" });
    const b = membre({ name: "ERIC DOXAT", id: "u2" });
    const g = invite({ name: "Doxat Eric" });
    expect(doublonsAppli([a, b, g])).toEqual([]);
  });

  it("deux invités homonymes : on ne conclut rien non plus", () => {
    const m = membre({ name: "Eric Doxat", id: "u1" });
    const g1 = invite({ name: "DOXAT ERIC", id: "g1" });
    const g2 = invite({ name: "Doxat Eric", id: "g2" });
    expect(doublonsAppli([m, g1, g2])).toEqual([]);
  });

  it("un invité déjà apparié n'est pas réattribué à un second membre", () => {
    const m1 = membre({ name: "Eric Doxat", id: "u1", licence: "1528030W" });
    const m2 = membre({ name: "Eric Doxat", id: "u2" });
    const g = invite({ name: "Eric Doxat", licence: "1528030W" });
    expect(doublonsAppli([m1, m2, g])).toEqual([{ membre: m1, invite: g, par: "licence" }]);
  });

  it("une équipe sans invité n'a évidemment aucun doublon", () => {
    expect(doublonsAppli([membre({ name: "A", id: "u1" }), membre({ name: "B", id: "u2" })])).toEqual([]);
  });
});
