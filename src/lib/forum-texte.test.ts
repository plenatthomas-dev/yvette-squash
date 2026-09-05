import { describe, it, expect } from "vitest";
import { segmenter, libelleJour, memeJour } from "./forum-texte";

// LE RENDU D'UN MESSAGE, sans jamais fabriquer de HTML.
//
// Le test qui porte tout le reste est le PREMIER : un message ordinaire doit ressortir
// strictement identique, en un seul morceau. Chercher des liens dans du texte est une occasion
// d'abîmer du texte, et c'est cette occasion qu'on ferme ici.

describe("segmenter — le texte ordinaire est intouché", () => {
  it("rend un message sans lien en UN SEUL segment, identique à l'entrée", () => {
    const t = "Salut tout le monde, on joue jeudi ?";
    expect(segmenter(t)).toEqual([{ type: "texte", valeur: t }]);
  });

  it("préserve les retours à la ligne et les emoji", () => {
    const t = "Covoiturage 🚗\n- Gégé\n- Thomas 👍";
    expect(segmenter(t)).toEqual([{ type: "texte", valeur: t }]);
  });

  it("rend une chaîne vide sans segment", () => {
    expect(segmenter("")).toEqual([]);
  });
});

// C'est le point de sécurité du module. On ne filtre pas `javascript:` — on ne le RECONNAÎT
// jamais, faute de le chercher. Un filtre se contourne ; une absence de reconnaissance, non.
describe("segmenter — seuls http et https deviennent des liens", () => {
  it("ne voit aucun lien dans un `javascript:`", () => {
    const t = "javascript:alert(1)";
    expect(segmenter(t)).toEqual([{ type: "texte", valeur: t }]);
  });

  it("ne voit aucun lien dans un `data:` ni un `vbscript:`", () => {
    for (const t of ["data:text/html,<script>x</script>", "vbscript:msgbox(1)"]) {
      expect(segmenter(t).every((s) => s.type === "texte")).toBe(true);
    }
  });

  it("ne reconnaît pas un schéma sans domaine", () => {
    expect(segmenter("https://").every((s) => s.type === "texte")).toBe(true);
  });
});

describe("segmenter — les vraies adresses", () => {
  it("isole un lien au milieu d'une phrase", () => {
    expect(segmenter("va voir https://squashnet.fr merci")).toEqual([
      { type: "texte", valeur: "va voir " },
      { type: "lien", valeur: "https://squashnet.fr" },
      { type: "texte", valeur: " merci" },
    ]);
  });

  // Sans ce rognage, le lien avalerait le point et mènerait à une page inexistante.
  it("rend à la phrase le point qui la termine", () => {
    expect(segmenter("c'est sur https://squashnet.fr/tournoi.")).toEqual([
      { type: "texte", valeur: "c'est sur " },
      { type: "lien", valeur: "https://squashnet.fr/tournoi" },
      { type: "texte", valeur: "." },
    ]);
  });

  it("garde une parenthèse qui appartient à l'adresse", () => {
    const [lien] = segmenter("https://fr.wikipedia.org/wiki/Squash_(sport)");
    expect(lien).toEqual({
      type: "lien",
      valeur: "https://fr.wikipedia.org/wiki/Squash_(sport)",
    });
  });

  it("rend la parenthèse qui fermait la phrase", () => {
    expect(segmenter("(voir https://squashnet.fr)")).toEqual([
      { type: "texte", valeur: "(voir " },
      { type: "lien", valeur: "https://squashnet.fr" },
      { type: "texte", valeur: ")" },
    ]);
  });

  it("trouve plusieurs liens dans le même message", () => {
    const s = segmenter("http://a.fr et https://b.fr");
    expect(s.filter((x) => x.type === "lien").map((x) => x.valeur)).toEqual([
      "http://a.fr",
      "https://b.fr",
    ]);
  });

  // L'invariant qui garantit qu'on n'a rien perdu en chemin, quel que soit le découpage.
  it("recolle toujours au texte d'origine", () => {
    for (const t of [
      "rien du tout",
      "https://a.fr",
      "avant https://a.fr après",
      "(https://a.fr/x_(y)) fin.",
    ]) {
      expect(segmenter(t).map((s) => s.valeur).join("")).toBe(t);
    }
  });
});

describe("libelleJour", () => {
  const ref = new Date("2026-09-05T12:00:00");

  it("dit « Aujourd'hui » et « Hier » plutôt qu'une date", () => {
    expect(libelleJour("2026-09-05T08:00:00", ref)).toBe("Aujourd'hui");
    expect(libelleJour("2026-09-04T23:30:00", ref)).toBe("Hier");
  });

  it("nomme le jour au-delà, avec une majuscule", () => {
    const l = libelleJour("2026-09-02T10:00:00", ref);
    expect(l).toMatch(/^Mercredi 2 septembre$/);
  });

  // La purge à 12 mois rend l'ambiguïté impossible dans l'année courante ; au-delà, l'année
  // apparaît, sinon « samedi 3 janvier » désignerait deux jours différents.
  it("ajoute l'année seulement quand elle diffère", () => {
    expect(libelleJour("2025-09-02T10:00:00", ref)).toMatch(/2025$/);
    expect(libelleJour("2026-09-02T10:00:00", ref)).not.toMatch(/2026$/);
  });
});

describe("memeJour", () => {
  it("regarde le jour civil, pas l'écart en heures", () => {
    // Deux heures d'écart, mais deux jours : c'est bien un séparateur qu'il faut poser.
    expect(memeJour("2026-09-04T23:00:00", "2026-09-05T01:00:00")).toBe(false);
    expect(memeJour("2026-09-05T00:01:00", "2026-09-05T23:59:00")).toBe(true);
  });
});
