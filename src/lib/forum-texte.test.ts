import { describe, it, expect } from "vitest";
import { segmenter, libelleJour, memeJour, replier, concorde, souligner } from "./forum-texte";

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

  // L'invariant du module est « un texte SANS adresse ressort en un seul segment, strictement
  // identique à l'entrée ». La chaîne vide en est un, et elle rendait `[]` — le seul cas où le
  // module se contredisait. Sans conséquence à l'écran, mais un invariant vrai à 99 % ne sert
  // pas d'invariant : c'est exactement ce qu'on cesse de vérifier avant de s'en servir.
  it("tient son invariant JUSQUE SUR la chaîne vide", () => {
    expect(segmenter("")).toEqual([{ type: "texte", valeur: "" }]);
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

  // ⚠️ `"https://"` seul ne rencontre JAMAIS le motif — il exige au moins un caractère après
  // les deux barres — donc il n'atteignait pas la garde qu'il prétendait couvrir : la
  // supprimer laissait ce test vert. Le vrai cas est `"https://."`, que le motif reconnaît et
  // que le rognage de ponctuation réduit ensuite à son schéma nu.
  it("ne reconnaît pas un schéma sans domaine, même après rognage de la ponctuation", () => {
    expect(segmenter("https://.").every((s) => s.type === "texte")).toBe(true);
    expect(segmenter("va voir https://, merci").every((s) => s.type === "texte")).toBe(true);
    // Et le cas dégénéré, qui n'atteint pas le motif du tout.
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

// ============================================================================
//  LA RECHERCHE DANS LE FIL.
// ============================================================================

// Le repli existe parce que `normalize()` de squashnet, qui replie déjà sans accent, COMPACTE
// la ponctuation et les espaces : ses positions ne désignent plus rien dans l'original. C'est
// sans conséquence pour rapprocher deux noms, et rédhibitoire pour souligner un passage.
describe("replier — les positions survivent au repli", () => {
  it("efface accents et casse", () => {
    expect(replier("Réservé Été").plie).toBe("reserve ete");
  });

  it("laisse la ponctuation et les espaces EN PLACE, contrairement à normalize()", () => {
    // C'est tout l'écart : `normalize()` rendrait « qui joue jeudi » sur trois mots compactés.
    expect(replier("Qui joue,  jeudi ?").plie).toBe("qui joue,  jeudi ?");
  });

  // LE test du module : l'index doit ramener une tranche du repli vers la tranche de l'original
  // qu'elle recouvre — sinon le soulignage décale, et marque le mauvais bout de phrase.
  it("ramène une position du repli vers le caractère d'origine", () => {
    const s = "J'ai réservé le 3";
    const { plie, index } = replier(s);
    const debut = plie.indexOf("reserve");
    expect(s.slice(index[debut], index[debut + "reserve".length])).toBe("réservé");
  });

  it("compte une position de plus que le repli : la borne de fin", () => {
    const { plie, index } = replier("été");
    expect(index).toHaveLength(plie.length + 1);
    expect(index.at(-1)).toBe(3);
  });

  // Un emoji occupe deux unités UTF-16. Avancer d'une seule décalerait tout ce qui suit, et
  // découperait un demi-caractère dans les tranches rendues.
  it("avance d'un EMOJI entier, pas d'une demi-unité", () => {
    const s = "bravo 🎾 Marie";
    const { plie, index } = replier(s);
    const debut = plie.indexOf("marie");
    expect(s.slice(index[debut])).toBe("Marie");
  });
});

describe("concorde — ce que la liste applique à chaque message", () => {
  it("trouve « réservé » quand on tape « reserve », et l'inverse", () => {
    expect(concorde("J'ai réservé le 3", "reserve")).toBe(true);
    expect(concorde("J'ai reserve le 3", "réservé")).toBe(true);
  });

  it("ignore la casse", () => {
    expect(concorde("Tournoi SAMEDI", "samedi")).toBe(true);
  });

  it("ne concorde pas avec ce qui n'y est pas", () => {
    expect(concorde("On joue jeudi", "dimanche")).toBe(false);
  });

  // Une requête vide, c'est le mode « pas de recherche » : elle ne doit pas concorder avec
  // tout, sans quoi effacer le champ ferait passer le fil entier par le chemin des résultats.
  it("ne concorde avec RIEN quand la requête est vide ou blanche", () => {
    expect(concorde("On joue jeudi", "")).toBe(false);
    expect(concorde("On joue jeudi", "   ")).toBe(false);
  });
});

describe("souligner — marquer sans rien casser", () => {
  it("isole le passage trouvé, accents ignorés", () => {
    expect(souligner(segmenter("J'ai réservé le 3"), "reserve")).toEqual([
      { type: "texte", valeur: "J'ai " },
      { type: "trouve", valeur: "réservé" },
      { type: "texte", valeur: " le 3" },
    ]);
  });

  it("marque TOUTES les occurrences, pas seulement la première", () => {
    const out = souligner(segmenter("jeudi ou jeudi ?"), "jeudi");
    expect(out.filter((s) => s.type === "trouve")).toHaveLength(2);
  });

  // Une adresse coupée en deux n'est plus cliquable. Le surlignage ne vaut pas ce prix.
  it("laisse les liens intacts, même quand la requête tombe dedans", () => {
    const out = souligner(segmenter("va voir https://squashnet.fr merci"), "squashnet");
    expect(out).toEqual([
      { type: "texte", valeur: "va voir " },
      { type: "lien", valeur: "https://squashnet.fr" },
      { type: "texte", valeur: " merci" },
    ]);
  });

  // Même invariant que `segmenter` : ne pas trouver ne doit rien abîmer. C'est le test qui
  // porte les autres — le soulignage est une occasion de découper du texte à tort.
  it("rend les segments STRICTEMENT inchangés quand rien ne concorde", () => {
    const segs = segmenter("Covoiturage 🚗\n- Gégé\n- Thomas 👍");
    expect(souligner(segs, "dimanche")).toEqual(segs);
    expect(souligner(segs, "")).toEqual(segs);
  });

  // Recoller les valeurs doit redonner le message. Une erreur d'index se verrait ici, et
  // nulle part ailleurs.
  it("conserve le texte à la lettre : recollé, il redonne l'original", () => {
    const t = "Été 2026 : réservé pour Gégé 🎾 — voir https://squashnet.fr/été";
    const recolle = souligner(segmenter(t), "e")
      .map((s) => s.valeur)
      .join("");
    expect(recolle).toBe(t);
  });
});
