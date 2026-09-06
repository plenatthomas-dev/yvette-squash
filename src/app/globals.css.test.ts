import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
//  UN BOUTON RETENU GARDE SON LIBELLÉ LISIBLE, MÊME SOUS LE DOIGT.
//
//  Le défaut, mesuré sur l'écran des disponibilités : la règle de survol
//  `.ic-dispo-buttons button:not(:disabled):hover` pèse (0,3,1) et redonnait
//  `color: var(--pico-contrast)` — c'est-à-dire exactement le FOND que
//  `.ic-dispo-buttons button[aria-pressed="true"]`, plus léger à (0,2,1), venait
//  de poser. Deux déclarations, une seule variable, texte invisible dans les
//  quatre thèmes.
//
//  Et il ne se rattrapait pas tout seul : un appareil tactile garde `:hover` sur
//  le dernier élément touché jusqu'à ce qu'on touche AILLEURS. On tapait
//  « Dispo », le bouton devenait un rectangle plein et muet, et le libellé ne
//  revenait qu'au premier appui sur un autre bouton — le temps de croire que la
//  réponse n'avait pas été prise.
//
//  Pourquoi un test de FICHIER et pas un test de rendu : jsdom n'applique
//  aucune feuille de style et ne calcule aucune spécificité. La règle est donc
//  vérifiée là où elle est écrite. Elle ne coûte rien et parle la langue du
//  défaut : « un survol ne redécrit pas la couleur d'un bouton pressé ».
// ============================================================================

const CSS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

/** Les sélecteurs d'une feuille, un par bloc, commentaires ôtés. */
function selecteurs(css: string): string[] {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("{")
    .slice(0, -1)
    .map((bloc) => bloc.slice(bloc.lastIndexOf("}") + 1).trim())
    .filter(Boolean);
}

describe("les groupes de boutons à choix unique", () => {
  it("ne laissent aucun survol redécrire la couleur du bouton RETENU", () => {
    // On ne regarde que les groupes qui portent l'état par `aria-pressed` : ce sont ceux dont le
    // bouton retenu est PLEIN, donc ceux où un survol qui repeint le texte le fait disparaître.
    const groupes = [...CSS.matchAll(/([.\w-]+)\s+button\[aria-pressed="true"\]/g)].map(
      (m) => m[1],
    );
    expect(groupes.length).toBeGreaterThan(0);

    const survols = selecteurs(CSS).filter((s) => s.includes(":hover"));
    for (const groupe of groupes) {
      for (const s of survols) {
        if (!s.includes(groupe)) continue;
        // Un survol qui vise ce groupe doit EXCLURE le bouton pressé. Le plus court chemin est
        // de ne pas le viser du tout : le choix retenu est déjà plein, gras et annoncé.
        expect(s, `${s} — le survol atteint le bouton retenu de ${groupe}`).toContain(
          ':not([aria-pressed="true"])',
        );
      }
    }
  });
});
