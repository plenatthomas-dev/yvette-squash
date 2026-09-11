import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTeamRoster, RosterUnreadableError, estRoster, nameKey } from "./roster";

// ============================================================================
//  LE VRAI ROSTER D'UNE ÉQUIPE — Verrieres 2, critérium 2025-2026, Hommes 4.
//
//  Fragment capté tel quel sur squashnet (`ic_a=393480`, teamid 161095 SEUL).
//  C'est une équipe de notre poule : ses joueurs sont ceux que nos capitaines
//  inscriront sur une feuille de match, et leurs classements ceux sur lesquels
//  se juge l'ordre des simples.
// ============================================================================

const html = readFileSync(
  join(__dirname, "__fixtures__", "equipe-2026-161095-roster.html"),
  "utf8",
);

describe("parseTeamRoster — le roster réel de Verrieres 2", () => {
  const roster = parseTeamRoster(html, "161095");

  it("lit les douze joueurs inscrits, dans l'ordre publié", () => {
    expect(roster.players.map((p) => p.name)).toEqual([
      "LAUNAY EMMANUEL",
      "LECOMTE ARNAUD",
      "MARTIN OLIVIER",
      "GOLLOT ENGUERRAN",
      "KHALFAOUI SOUHAIEL",
      "TRAN CEDRIC",
      "TRONCHE GUILLAUME",
      "LEBREUILLY GREGOIRE",
      "POPULU AXEL",
      "PETEL JULIEN",
      "BERGER MATHIEU",
      "DETRY XAVIER",
    ]);
  });

  it("distingue l'ÉQUIPE (numérotée) du CLUB — c'est ce que le rapprochement cherchait", () => {
    // « Verrieres 2 » est l'équipe ; « Squash club verrieres le buisson » est le club sous
    // lequel la fédération range les joueurs. Confondre les deux est exactement le bug que
    // `clubOfTeam` a dû corriger — ici la fédération donne les deux, il n'y a plus à deviner.
    expect(roster.teamName).toBe("Verrieres 2");
    expect(roster.code).toBe("VERR2");
    expect(roster.club).toBe("Squash club verrieres le buisson");
    expect(roster.captain).toBe("POPULU AXEL");
  });

  it("donne licence, classement et rang mixte — plus rien à rapprocher", () => {
    // Le premier de la liste, avec ses quatre valeurs telles que la ligue les publie. C'est
    // exactement ce qu'un capitaine recopie sur le formulaire fédéral.
    expect(roster.players[0]).toEqual({
      name: "LAUNAY EMMANUEL",
      gender: "Mr.",
      licence: "1463138W",
      clt: "4D",
      rang: 2158,
      rangM: 2269,
      registeredAt: "2025-09-22",
    });
  });

  it("garde « NC » comme classement, et le rang qui va avec", () => {
    // Un NC a bien un rang (9389) : le mettre à null le placerait EN TÊTE de l'ordre des
    // simples, donc devant les mieux classés de son équipe.
    const nc = roster.players.find((p) => p.name === "MARTIN OLIVIER");
    expect(nc?.clt).toBe("NC");
    expect(nc?.rang).toBe(9389);
    expect(nc?.rangM).toBe(9389);
  });

  it("lit les licences des DEUX formats que la fédération émet", () => {
    // « 0113258 » (ancien, sept chiffres) et « 1704418F » (avec sa lettre de contrôle) : les
    // deux existent dans la même équipe. Un parsing numérique perdrait la lettre en silence.
    const licences = roster.players.map((p) => p.licence);
    expect(licences).toContain("0113258");
    expect(licences).toContain("1704418F");
    expect(licences.every((l) => l !== null)).toBe(true);
  });

  it("range les dates d'inscription en ISO, pour qu'elles se trient", () => {
    // Publiées « 22-09-2025 ». Gardées telles quelles, le renfort d'octobre (« 04-10-2025 »)
    // trierait AVANT l'effectif de septembre — l'ordre exact que l'ISO rétablit.
    const dates = roster.players.map((p) => p.registeredAt);
    expect(dates).toContain("2025-09-22");
    expect(dates).toContain("2025-10-04");
    expect([...dates].sort().at(-1)).toBe("2025-10-04");
  });

  it("porte l'identifiant DEMANDÉ, donc jamais celui d'une autre équipe", () => {
    expect(roster.snTeamId).toBe("161095");
  });

  it("a la forme que la garde de relecture attend", () => {
    expect(estRoster(roster)).toBe(true);
  });
});

describe("parseTeamRoster — refuse de deviner", () => {
  it("jette si le tableau de CETTE équipe manque, au lieu de rendre une liste vide", () => {
    // La panne muette qu'on veut rendre impossible : la fédération ignore un identifiant
    // (elle le fait déjà sans `drawid`, cf. `standings.ts`) et rend une page crédible où nos
    // joueurs ne sont pas. Un roster vide s'afficherait comme « l'équipe n'a inscrit
    // personne » — un contresens qu'aucun capitaine ne pourrait démentir.
    expect(() => parseTeamRoster(html, "161096")).toThrow(RosterUnreadableError);
  });

  it("rend une liste VIDE si le tableau est là mais sans joueur", () => {
    // Une équipe inscrite sans joueur est un fait de début de saison, pas une panne : la
    // distinction avec le cas précédent est tout l'objet de `RosterUnreadableError`.
    const vide = '<table id="players_999"><thead><tr><th>Nom Prénom</th></tr></thead></table>';
    expect(parseTeamRoster(vide, "999").players).toEqual([]);
  });

  it("tolère les guillemets SIMPLES — squashnet a déjà basculé une fois", () => {
    const simple = "<table id='players_999'><tr><td data-label='Nom Prénom'>DUPONT JEAN</td></tr></table>";
    expect(parseTeamRoster(simple, "999").players.map((p) => p.name)).toEqual(["DUPONT JEAN"]);
  });
});

describe("nameKey — l'ordre des mots ne fait pas deux joueurs", () => {
  it("apparie le nom fédéral et celui d'une feuille de match", () => {
    // « POPULU AXEL » chez la fédération, « Axel Populu » sur la feuille. Sans cette clé, le
    // roster n'enrichirait jamais un nom déjà saisi et le menu proposerait les deux.
    expect(nameKey("POPULU AXEL")).toBe(nameKey("Axel Populu"));
    expect(nameKey("DETRY XAVIER")).toBe(nameKey("xavier détry"));
  });

  it("ne replie PAS une faute de frappe, ni un prénom écrit d'un seul côté", () => {
    // La limite est assumée et documentée : on ne devine pas.
    expect(nameKey("Detri Xavier")).not.toBe(nameKey("Detry Xavier"));
    expect(nameKey("Dupont Jean Marie")).not.toBe(nameKey("Dupont Jean"));
  });

  it("rend la chaîne vide sur un nom vide, qui ne peut apparier personne", () => {
    expect(nameKey("   ")).toBe("");
  });
});

describe("parseTeamRoster — l'identité de l'équipe ne se décale pas", () => {
  // ⚠️ LE CAS QUI CASSAIT. L'appariement se faisait par POSITION, après avoir écarté les cases
  // vides : un club sans site internet décalait la colonne suivante, et « Association » — le nom
  // du CLUB, celui sous lequel la fédération range ses joueurs — prenait la place du site.
  // En silence, sur un club parfaitement ordinaire.
  const sansSite = `
    <table id="info" class="table">
      <tr><th>Nom</th><th>Sigle</th><th>Capitaine</th><th>Site internet</th><th>Association</th></tr>
      <tr>
        <td data-label="Nom">Chaville 4</td>
        <td data-label="Sigle">CHAV4</td>
        <td data-label="Capitaine">DUPONT JEAN</td>
        <td data-label="Site internet"></td>
        <td data-label="Association">Squash club de Chaville</td>
      </tr>
    </table>
    <table id="players_42"><tr><td data-label="Nom Prénom">DUPONT JEAN</td></tr></table>`;

  it("garde le CLUB à sa place quand une colonne est vide", () => {
    const r = parseTeamRoster(sansSite, "42");
    expect(r.club).toBe("Squash club de Chaville");
    expect(r.teamName).toBe("Chaville 4");
    expect(r.code).toBe("CHAV4");
    expect(r.captain).toBe("DUPONT JEAN");
  });

  it("ne dépend pas de l'ORDRE des colonnes", () => {
    // C'est ce que `data-label` achète : une colonne insérée ou déplacée par la ligue ne
    // déplace plus rien.
    const inverse = `
      <table id="info">
        <tr>
          <td data-label="Association">Squash club de Chaville</td>
          <td data-label="Nom">Chaville 4</td>
        </tr>
      </table>
      <table id="players_42"><tr><td data-label="Nom Prénom">DUPONT JEAN</td></tr></table>`;
    const r = parseTeamRoster(inverse, "42");
    expect(r.club).toBe("Squash club de Chaville");
    expect(r.teamName).toBe("Chaville 4");
  });

  it("rend null, jamais la chaîne vide, sur une case présente mais vide", () => {
    // Une chaîne vide se teste mal : `roster.club ?? clubOfTeam(...)` la laisserait passer et
    // on chercherait les joueurs sous un club sans nom.
    const r = parseTeamRoster(sansSite, "42");
    expect(r).toMatchObject({ club: expect.any(String) });
    const vide = parseTeamRoster(
      `<table id="info"><tr><td data-label="Nom"> </td></tr></table>
       <table id="players_42"><tr><td data-label="Nom Prénom">A B</td></tr></table>`,
      "42",
    );
    expect(vide.teamName).toBeNull();
  });

  it("rend une identité vide, sans jeter, quand le tableau info manque", () => {
    const r = parseTeamRoster(
      '<table id="players_42"><tr><td data-label="Nom Prénom">A B</td></tr></table>',
      "42",
    );
    expect(r).toMatchObject({ teamName: null, code: null, club: null, captain: null });
    expect(r.players).toHaveLength(1);
  });
});
