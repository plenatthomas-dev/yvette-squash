import { describe, it, expect } from "vitest";
import { texte } from "./html";

// `texte` est la seule fonction de décodage des trois parseurs (fiche d'équipe, feuille de
// match, classement) et du calendrier : ce qu'elle laisse passer, ils le laissent tous passer.
describe("texte", () => {
  it("retire les balises et déplie les entités courantes", () => {
    expect(texte("<b>Squash de l&#39;Yvette</b>&nbsp;&amp; Massy")).toBe(
      "Squash de l'Yvette & Massy",
    );
  });

  it("ne déplie qu'UNE fois : « &amp;#39; » est le texte littéral « &#39; »", () => {
    expect(texte("A &amp;#39; B &amp;nbsp; C")).toBe("A &#39; B &nbsp; C");
  });

  it("retire aussi une balise ouverte et jamais refermée", () => {
    expect(texte("Massy <script")).toBe("Massy");
    expect(texte("Massy</td")).toBe("Massy");
  });
});
