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

// ============================================================================
//  UNE RENCONTRE VÉRIFIÉE TIENT DANS UNE CAPTURE D'ÉCRAN DE TÉLÉPHONE.
//
//  L'écran Capitaine se prend en photo : on le montre à son équipe, ou on le
//  garde pour saisir plus tard chez la fédération. Il faut donc que « 4-0 sur
//  4 simples » ET les quatre vignettes, jusqu'au second joueur du dernier
//  simple, tiennent d'un seul tenant.
//
//  Ça ne se voit PAS en relisant le CSS, et ça ne se voit pas non plus en jsdom,
//  qui n'applique aucune feuille et ne calcule aucune hauteur. Mais ça se
//  CALCULE : les hauteurs en jeu sont toutes des `padding`, des `gap`, des
//  `font-size` et une `line-height`, toutes écrites dans la feuille. Ce test
//  refait l'addition à partir des valeurs réelles.
//
//  ⚠️ CE QU'IL PROTÈGE, C'EST LA QUATRIÈME VIGNETTE. Elle tombe hors de l'écran
//  en silence : rien ne casse, rien ne s'affiche de travers, la capture est
//  simplement incomplète — et on ne s'en aperçoit qu'en la regardant, plus tard,
//  quand on cherche la licence du dernier joueur.
//
//  Le point de départ mesuré, avant resserrage : 937 px pour ~640 visibles.
// ============================================================================

/** Le corps d'une règle, sélecteur EXACT (« .cap-simple » ne rend pas « .cap-simple.cap-ko »). */
function regle(selecteur: string): string {
  const sans = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = new RegExp(
    "(?:^|[};])\\s*" + selecteur.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}",
    "m",
  );
  const m = re.exec(sans);
  if (!m) throw new Error("règle introuvable : " + selecteur);
  return m[1];
}

/** Une longueur en px déclarée dans une règle. `rem` est converti à 16 px (racine du mobile). */
function px(selecteur: string, prop: string, rang = 0): number {
  const m = new RegExp("(?:^|;)\\s*" + prop + "\\s*:([^;]*)").exec(regle(selecteur));
  if (!m) throw new Error(prop + " absent de " + selecteur);
  const valeurs = m[1].trim().split(/\s+/);
  const v = valeurs[Math.min(rang, valeurs.length - 1)];
  if (v.endsWith("rem")) return Number.parseFloat(v) * 16;
  return Number.parseFloat(v);
}

describe("l'écran Capitaine tient dans une capture d'écran", () => {
  // La feuille du téléphone de référence : 390 px de large, ~640 px réellement visibles une
  // fois les barres du navigateur déduites. La racine y vaut 16 px (Pico ne monte à 106 % qu'à
  // partir de 576 px).
  const VISIBLE = 640;

  /** La hauteur d'une ligne de texte, à la `line-height` de la vignette. */
  const ligne = (rem: number) => rem * 16 * INTERLIGNE;
  const INTERLIGNE = 1.35;

  it("⚠️ « 4-0 » et les QUATRE vignettes tiennent d'un seul tenant", () => {
    // L'interligne de la vignette est ce qui multiplie tout le reste : s'il repasse à 1.5,
    // l'addition ci-dessous change de vingt pour cent.
    expect(px(".cap-simple", "line-height")).toBeCloseTo(INTERLIGNE, 2);

    // --- Le compte de la rencontre ------------------------------------------
    const tie =
      px(".cap-tie", "margin", 2) + // marge basse
      px(".cap-tie", "padding") * 2 +
      1.25 * 16 * 1.5; // le score, en 1,25rem, à l'interligne du corps de texte

    // --- Une vignette --------------------------------------------------------
    // Trois enfants : la ligne de titre (numéro + jeu par jeu + total), puis les DEUX joueurs.
    const titre = ligne(0.95); // `.ic-row` pose 0,95rem, le plus grand de la ligne
    const joueur = px(".cap-joueur", "margin-top") + ligne(0.85); // nom et fiche sur une ligne
    const vignette =
      2 + // les deux bords
      px(".cap-simple", "padding") * 2 +
      px(".cap-simple", "gap") * 2 +
      titre +
      joueur * 2;

    const total = tie + vignette * 4 + px(".cap-simples", "gap") * 3;

    // La marge restante doit rester CONFORTABLE : une vignette qui frôle la limite tombe hors
    // de l'écran au premier nom long, et personne ne s'en aperçoit avant d'avoir besoin de la
    // licence du dernier joueur.
    // Mesuré à 427 px au moment où ce test est écrit, contre 937 avant resserrage. La marge
    // n'est pas du luxe : elle absorbe les repliements (un nom long, cinq jeux sur un écran
    // étroit), qui coûtent jusqu'à 200 px de plus sur une rencontre entière.
    expect(total).toBeLessThan(VISIBLE - 80);
  });

  it("⚠️ annule le `margin-top` que `.tiny` impose à la ligne d'identité", () => {
    // LE PIÈGE, ET IL A COÛTÉ 112 px. `.tiny` porte `margin-top: 14px` pour les paragraphes
    // d'aide. Sur `.cap-fiche`, le span devient un ÉLÉMENT FLEX — donc un bloc — et ce margin
    // s'applique : 14 px × 2 joueurs × 4 simples, pour un espacement que personne n'avait
    // demandé et que personne ne voyait.
    expect(px(".tiny", "margin-top")).toBeGreaterThan(0);
    expect(px(".cap-fiche", "margin-top")).toBe(0);
    expect(px(".cap-hint", "margin-top")).toBe(0);
  });

  it("prend ses tailles dans la rampe de DESIGN.md, jamais entre deux crans", () => {
    // « La Règle du Cran Voisin » : un écart de deux centièmes de rem ne se lit pas comme un
    // système, il se lit comme une inattention. `.cap-jeu` portait 0,78rem — une survivance que
    // DESIGN.md nomme explicitement comme ne devant pas servir de précédent.
    const RAMPE = [0.72, 0.75, 0.8, 0.85, 0.9];
    for (const sel of [".cap-jeu", ".cap-joueur-nom", ".cap-numero", ".cap-marque"]) {
      expect(RAMPE).toContain(Number((px(sel, "font-size") / 16).toFixed(2)));
    }
  });
});

// ============================================================================
//  LES DEUX CASES DE MARQUAGE — les seuls boutons de l'appli qu'on tape en rafale.
//
//  Cinquante appuis par jeu, sur un téléphone posé au bord du court, par
//  quelqu'un qui regarde le court et non l'écran. C'est exactement le régime où
//  le navigateur mobile prend deux appuis rapprochés pour un DOUBLE-APPUI et
//  zoome, et où un appui maintenu — geste ordinaire quand on hésite — SÉLECTIONNE
//  le nom du joueur et fait surgir le menu « Copier ».
//
//  Les deux propriétés qui l'empêchent sont posées ailleurs dans cette feuille
//  depuis longtemps, pour exactement ces raisons. Elles manquaient au seul
//  endroit où le geste est répété.
// ============================================================================

describe("les cases de marquage supportent la rafale d'appuis", () => {
  /** Le corps de la règle `.ics-side`, commentaires ôtés. */
  const caseDeMarquage = () => {
    const sans = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    const m = /(?:^|[};])\s*\.ics-side\s*\{([^}]*)\}/m.exec(sans);
    expect(m).not.toBeNull();
    return (m as RegExpExecArray)[1];
  };

  it("n'ouvre pas le zoom au double-appui", () => {
    expect(caseDeMarquage()).toMatch(/touch-action\s*:\s*manipulation/);
  });

  it("ne laisse pas un appui maintenu sélectionner le nom du joueur", () => {
    // Le préfixe `-webkit-` compte : c'est Safari iOS qui fait surgir la loupe et le menu.
    expect(caseDeMarquage()).toMatch(/-webkit-user-select\s*:\s*none/);
    expect(caseDeMarquage()).toMatch(/(?:^|;)\s*user-select\s*:\s*none/);
  });
});
