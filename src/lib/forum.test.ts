import { describe, it, expect } from "vitest";
import { parseForumBody, forumLength, forumPreview, MAX_FORUM_LEN } from "./forum";

// LA TRONCATURE DES EMOJI, ET RIEN D'AUTRE.
//
// Ce module existe pour une seule raison : `String.prototype.slice` compte en unités UTF-16,
// or un emoji en occupe deux. Le helper de la maison (`parseOptionalText`) coupe donc au
// milieu d'une paire de substituts et écrit un demi-caractère en base. Les tests ci-dessous
// sont ceux qui justifient d'avoir écrit une fonction de plus plutôt que de réutiliser
// l'existante ; s'ils tombent, le module n'a plus de raison d'être.

describe("parseForumBody — la limite", () => {
  it("NE CASSE PAS un emoji posé exactement sur la limite", () => {
    // 999 caractères puis un 👍 : le pouce est le millième, il doit passer ENTIER.
    const s = "a".repeat(MAX_FORUM_LEN - 1) + "👍";
    const out = parseForumBody(s)!;
    expect(forumLength(out)).toBe(MAX_FORUM_LEN);
    expect(out.endsWith("👍")).toBe(true);
    // La preuve par la négative : c'est exactement ce que `slice` aurait produit.
    expect(s.slice(0, MAX_FORUM_LEN).endsWith("👍")).toBe(false);
  });

  it("coupe ENTRE deux emoji, jamais au milieu d'un", () => {
    const out = parseForumBody("👍".repeat(MAX_FORUM_LEN + 10))!;
    expect(forumLength(out)).toBe(MAX_FORUM_LEN);
    // Un demi-emoji se lit \uD83D ou \uDC4D orphelin : aucun substitut isolé ne doit rester.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false);
  });

  it("compte en caractères visibles, pas en unités UTF-16", () => {
    // Dix pouces = dix caractères pour un humain, vingt pour `.length`.
    const dix = "👍".repeat(10);
    expect(dix.length).toBe(20);
    expect(forumLength(dix)).toBe(10);
    expect(parseForumBody(dix)).toBe(dix);
  });

  it("laisse passer un emoji composé sans le mutiler", () => {
    // Famille et drapeau : séquences à jointeur de largeur nulle et paires régionales.
    const s = "Bravo 👨‍👩‍👧‍👦 🇫🇷 !";
    expect(parseForumBody(s)).toBe(s);
  });
});

describe("parseForumBody — le texte", () => {
  it("GARDE les retours à la ligne, contrairement aux champs de l'interclub", () => {
    expect(parseForumBody("Covoit jeudi :\n- Thomas\n- Gégé")).toBe("Covoit jeudi :\n- Thomas\n- Gégé");
  });

  it("réduit les espaces horizontaux mais pas les sauts de ligne", () => {
    expect(parseForumBody("a   \t  b\nc")).toBe("a b\nc");
  });

  it("ramène trois sauts de ligne ou plus à deux", () => {
    expect(parseForumBody("a\n\n\n\n\nb")).toBe("a\n\nb");
  });

  it("rend null sur le vide, les espaces seuls et les mauvais types", () => {
    expect(parseForumBody("")).toBeNull();
    expect(parseForumBody("   \t \n ")).toBeNull();
    expect(parseForumBody(42)).toBeNull();
    expect(parseForumBody(null)).toBeNull();
    expect(parseForumBody(undefined)).toBeNull();
    expect(parseForumBody({ body: "coucou" })).toBeNull();
  });
});

describe("forumPreview", () => {
  it("aplatit les sauts de ligne : une notification tient sur une ligne", () => {
    expect(forumPreview("Covoit jeudi :\n- Thomas\n- Gégé")).toBe("Covoit jeudi : - Thomas - Gégé");
  });

  it("pose une ellipse plutôt que de laisser croire que le message s'arrête là", () => {
    const out = forumPreview("a".repeat(200));
    expect(forumLength(out)).toBe(120);
    expect(out.endsWith("…")).toBe(true);
  });

  it("ne coupe pas un emoji en deux non plus", () => {
    const out = forumPreview("👍".repeat(200), 10);
    expect(forumLength(out)).toBe(10);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });

  it("laisse un message court intact, sans ellipse", () => {
    expect(forumPreview("Bien joué 💪")).toBe("Bien joué 💪");
  });
});
