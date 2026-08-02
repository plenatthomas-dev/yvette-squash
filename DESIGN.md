---
name: Squash de l'Yvette
description: Outil de vestiaire — une grille de planning dense, lisible d'un pouce, où le vert ne décore jamais
colors:
  vert-signal: "#1f9d57"
  vert-signal-survol: "#24b365"
  vert-libre: "#158044"
  vert-libre-survol: "#127a40"
  reserve-surface: "#f7dfe6"
  reserve-encre: "#9c2f56"
  club-surface: "#dbe7ff"
  club-encre: "#29508f"
  ferme: "#eceef2"
  passe: "#e4e7ec"
  passe-encre: "#5b626e"
  bleu-info: "#2f6fe0"
  notice-fond: "#eef2f8"
  rouge-encre: "#b3261e"
  rouge-alerte: "#e5484d"
  page-claire: "#e9ecf1"
  carte-claire: "#ffffff"
  page-sombre: "#0e1116"
  carte-sombre: "#191e26"
  rose-short: "#e6007e"
typography:
  display:
    fontFamily: "system-ui, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, Helvetica, Arial, sans-serif"
    fontSize: "clamp(1.25rem, 5vw, 1.5rem)"
    fontWeight: 700
    lineHeight: 1.15
  title:
    fontFamily: "system-ui, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, Helvetica, Arial, sans-serif"
    fontSize: "1.02rem"
    fontWeight: 600
  body:
    fontFamily: "system-ui, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, Helvetica, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "system-ui, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, Helvetica, Arial, sans-serif"
    fontSize: "0.85rem"
    fontWeight: 500
  micro:
    fontFamily: "system-ui, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, Helvetica, Arial, sans-serif"
    fontSize: "0.62rem"
    fontWeight: 700
    lineHeight: "16px"
rounded:
  sm: "8px"
  md: "12px"
  lg: "16px"
  controle: "10px"
  pilule: "999px"
components:
  button-primary:
    backgroundColor: "{colors.vert-signal}"
    textColor: "#ffffff"
    rounded: "{rounded.controle}"
  button-primary-hover:
    backgroundColor: "{colors.vert-signal-survol}"
  cell-free:
    backgroundColor: "{colors.vert-libre}"
    textColor: "#ffffff"
    typography: "{typography.label}"
  cell-free-hover:
    backgroundColor: "{colors.vert-libre-survol}"
  cell-booked:
    backgroundColor: "{colors.reserve-surface}"
    textColor: "{colors.reserve-encre}"
  cell-club:
    backgroundColor: "{colors.club-surface}"
    textColor: "{colors.club-encre}"
    padding: "4px"
  cell-closed:
    backgroundColor: "{colors.ferme}"
  notice:
    backgroundColor: "{colors.notice-fond}"
    rounded: "{rounded.sm}"
    padding: "10px 14px"
  card:
    backgroundColor: "{colors.carte-claire}"
    rounded: "{rounded.md}"
---

# Design System: Squash de l'Yvette

## Overview

**Creative North Star: "L'outil de vestiaire"**

Cette interface est un outil qu'on sort debout, d'une main, entre deux portes. Elle ne cherche
ni à impressionner ni à accueillir : elle répond. La densité est ici une qualité assumée —
l'échelle typographique descend jusqu'à 0,62rem et une case de tableau porte à la fois un nom,
des présences et un badge, parce que voir plus d'un coup d'œil vaut mieux que scroller.

Le système est délibérément sobre et fonctionnel : Pico CSS assure toute la base (typographie,
formulaires, boutons, thème sombre), et la couche maison ne fait qu'ajouter ce que Pico ne
connaît pas — la palette des états de créneau, la grille, la barre d'outils. Aucune police n'est
chargée : la typographie est celle du système d'exploitation. Ce n'est pas un oubli, c'est
cohérent avec l'outil : rendu natif, aucun octet de webfont, aucun décalage de rendu.

Le relief est ambiant. Les ombres à deux couches et le léger dégradé de surface donnent une
facture moderne, mais ils n'encodent aucune hiérarchie : ils habillent, ils n'informent pas. La
seule couleur qui parle est le vert.

**Anti-référence confirmée : ResaMania.** L'appli existe parce que son amont oblige à naviguer
pour savoir s'il reste un terrain. Reproduire cette logique — enfouir la réponse derrière un
clic — serait perdre la raison d'être du produit.

**Key Characteristics:**
- Densité assumée, jamais cryptique : chaque abréviation est étiquetée ou porte un `title`.
- Un seul accent, le vert, strictement réservé à ce qui est jouable ou actionnable.
- Typographie 100 % système, aucune police chargée.
- Relief décoratif à coût runtime nul (CSS pur), retéclé par thème pour rester visible.
- Trois thèmes complets et égaux : clair, sombre, et « short rose ».

## Colors

Une palette de signal posée sur des neutres froids : le vert tranche, les états de créneau sont
des pastels sourds, et tout le reste est gris-bleu.

### Primary

- **Vert Signal** (`vert-signal`) : l'unique accent. Boutons primaires, contours de focus,
  éléments actionnables. Il ne décore jamais.
- **Vert Signal Survol** (`vert-signal-survol`) : état de survol du primaire, plus lumineux.
- **Vert Libre** (`vert-libre`) : le vert des cases réservables dans la grille. Volontairement
  plus profond que le primaire pour atteindre un contraste AA (5:1) du texte blanc sur la case —
  la lisibilité de la grille prime sur l'uniformité de la marque.
- **Vert Libre Survol** (`vert-libre-survol`) : survol et appui sur une case libre.

### Secondary

- **Bleu Info** (`bleu-info`) : liseré gauche des encarts d'information, signaux neutres non
  urgents. Jamais utilisé pour une action.
- **Rouge Alerte** (`rouge-alerte`) et **Rouge Encre** (`rouge-encre`) : erreurs et actions
  destructrices. Le liseré et le texte, jamais un aplat de fond.

### Tertiary

Les états de créneau, qui ne sont ni des accents ni des neutres mais un vocabulaire à part :

- **Réservé** (`reserve-surface` / `reserve-encre`) : créneau pris par quelqu'un d'autre. Rose
  sourd, lisible mais éteint — il ne sollicite pas le regard puisqu'on ne peut rien en faire.
- **Club** (`club-surface` / `club-encre`) : créneau de l'asso, ou le sien. Bleu clair. Le même
  bleu sert aux deux ; seule l'étoile (★) dans le contenu distingue « mes créneaux ».
- **Fermé** (`ferme`) : hors ouverture. Gris quasi neutre.
- **Passé** (`passe` / `passe-encre`) : créneau écoulé. Paire dédiée et non une opacité —
  l'opacité composite le texte AVEC le fond et fait tomber le contraste sous 2,5:1, ce qui
  ne « grise » pas le texte mais le fait disparaître.

### Neutral

- **Page Claire** (`page-claire`) et **Carte Claire** (`carte-claire`) : le fond de page est
  volontairement plus foncé que les cartes. C'est ce contraste — et non l'ombre seule — qui fait
  flotter les surfaces.
- **Page Sombre** (`page-sombre`) et **Carte Sombre** (`carte-sombre`) : en thème sombre la
  logique s'inverse, la carte est plus CLAIRE que la page ; le fond reste toujours le plus foncé.
- **Notice Fond** (`notice-fond`) : fond des encarts d'information.

### Named Rules

**La Règle du Vert Actionnable.** Le vert ne se pose que sur ce qu'on peut toucher : un bouton
primaire, une case libre, un contour de focus. Un élément vert non actionnable est une faute, et
elle se repère à l'œil nu sur une capture d'écran.

**La Règle du Fond Toujours Plus Sombre.** Quel que soit le thème, la page est plus sombre que
les cartes en clair, et plus sombre que tout en sombre. Une carte qui se confond avec sa page a
cassé le système, même si son ombre est intacte.

**La Règle du Contraste Avant la Marque.** Quand la couleur de marque ne passe pas le seuil AA
sur une surface, c'est la couleur qui plie. `vert-libre` existe uniquement pour cette raison.

## Typography

**Display Font :** pile système (`system-ui`, puis Segoe UI, Roboto, Helvetica, Arial)
**Body Font :** identique — une seule famille dans tout le produit
**Label/Mono Font :** aucune police monospace n'est utilisée

**Character :** neutre et natif. Le texte ressemble à celui du téléphone qui l'affiche, pas à
celui d'une marque. Le caractère du produit vient du ton des mots (tutoiement, phrases courtes)
et des emojis fonctionnels, jamais du dessin des lettres.

### Hierarchy

- **Display** (700, `clamp(1.25rem, 5vw, 1.5rem)`, line-height 1.15) : titre de l'en-tête
  applicatif, aux côtés du logo. Le `clamp` évite qu'il pousse les icônes sur petit écran.
- **Title** (600, 1.02rem) : titres de cartes et de sections.
- **Body** (400, 1rem, line-height 1.5) : texte courant, hérité de Pico.
- **Label** (500, 0.85rem) : encarts, textes secondaires, libellés de la barre d'outils.
- **Micro** (700, 0.62–0.66rem, line-height 16–18px) : badges, pastilles de comptage, présences
  empilées dans une case. Le poids 700 compense la taille.

**⚠️ L'échelle ci-dessus décrit les RÔLES, pas l'implémentation.** Le code contient
**vingt-cinq tailles de police distinctes** entre 0,58rem et 2rem. Il n'existe donc pas
d'échelle typographique tokenisée, exactement comme pour l'espacement — c'est un fait du
système, pas une recommandation. Les cinq rôles nommés ici sont la cible vers laquelle
converger : une nouvelle règle doit se rattacher à l'un d'eux plutôt qu'introduire une
vingt-sixième valeur.

### Named Rules

**La Règle du Micro Étiqueté.** En dessous de 0,75rem, un texte doit être soit un chiffre, soit
accompagné d'un libellé accessible (`title`, `aria-label`, ou texte `sr-only`). La densité se
gagne par l'étiquetage, jamais en supposant que le lecteur sait déjà.

## Layout

Le produit tient dans un conteneur central plafonné (~900px par défaut), que certaines pages
d'administration élargissent ponctuellement (1000–1200px) quand leur contenu est tabulaire ou en
grille. Les cartes d'outils s'organisent en colonnes CSS (`column-width: 440px`), ce qui donne
deux colonnes sur ordinateur et une seule sur mobile sans trou de hauteur.

Le composant central, la grille de planning, déroge à tout : elle occupe la pleine largeur
disponible, défile horizontalement dans son propre conteneur, et fige ses deux axes — l'en-tête
des terrains en haut, la colonne des heures à gauche. Le coin haut-gauche passe au-dessus des
deux. Cette mécanique est ce qui rend la vue semaine praticable au pouce.

**Un seul point de rupture est déclaré : 560px.** En dessous, la barre d'outils et la grille se
resserrent. Il n'y a pas d'échelle d'espacement tokenisée : les marges et paddings récurrents
(4, 6, 10, 14, 16, 18px) sont posés au cas par cas. C'est un fait du système, pas une
recommandation — une nouvelle surface devrait réutiliser ces valeurs plutôt qu'en inventer.

### Named Rules

**La Règle des Deux Axes.** Dans toute vue tabulaire dense, l'en-tête et la première colonne
restent visibles pendant le défilement. Une donnée qu'on ne peut plus rattacher à sa ligne et à
sa colonne ne vaut rien.

## Elevation & Depth

Le système utilise des ombres, mais **de façon ambiante** : elles donnent la facture moderne
(deux couches, diffusion large, dans l'esprit Linear/Vercel) sans encoder de hiérarchie. Trois
niveaux existent — `elev-1`, `elev-2`, `elev-3` — et sont entièrement retéclés selon le thème,
parce qu'une ombre calculée pour du gris clair devient invisible sur un fond sombre. Un léger
dégradé de surface (`card-grad`) se superpose aux cartes pour éviter l'aplat mort.

La profondeur ne repose pas uniquement sur l'ombre : le contraste page/carte fait au moins
autant de travail (cf. la Règle du Fond Toujours Plus Sombre). En thème sombre, la hiérarchie
s'exprime surtout par la clarté relative des surfaces.

### Shadow Vocabulary

- **`--elev-1`** (`0 2px 4px rgba(16,24,40,.10), 0 8px 18px rgba(16,24,40,.14)` en clair) :
  surfaces au repos, cartes.
- **`--elev-2`** (`0 4px 10px rgba(16,24,40,.14), 0 18px 38px rgba(16,24,40,.20)`) : éléments
  qui se détachent du flux — encarts, badge du logo.
- **`--elev-3`** (`0 10px 24px rgba(16,24,40,.20), 0 34px 70px rgba(16,24,40,.28)`) : le plus
  fort, porté par le conteneur de la grille.
- **`--lift`** (`-4px`) : soulèvement au survol, appliqué en `transform` pour rester composé par
  le GPU.

### Named Rules

**La Règle du Coût Nul.** Le relief est intégralement CSS et ne coûte rien à l'exécution. Tout
effet de profondeur qui demanderait du JavaScript, un filtre de flou animé ou un recalcul par
image est refusé — les téléphones du club ne sont pas des machines de développement.

## Shapes

Langage de formes doux et régulier, sans angle vif ni découpe. Cinq rayons portent
l'essentiel : `sm` (8px, `--radius-sm`) pour les encarts, `md` (12px, `--radius`) pour les
cartes et le conteneur de grille, `lg` (16px, `--radius-lg`) pour les modales et le panneau
d'annonce, `controle` (10px, `--pico-border-radius`) pour les boutons et les champs, et
`pilule` (999px) pour les chips, badges et pastilles.

Deux formes de dérive coexistent, et elles n'appellent pas la même réponse :

- **Des littéraux qui doublonnent un token.** `8px`, `10px` et `12px` sont écrits en dur à
  une vingtaine d'endroits alors que `--radius-sm`, `--pico-border-radius` et `--radius`
  existent. Correction mécanique et sans risque visuel : utiliser le token.
- **Six valeurs hors échelle** (4, 6, 7, 9, 11, 24px), utilisées une ou deux fois chacune.
  Celles-là demandent un arbitrage : se rattacher à l'échelle, ou justifier l'exception.
  `pilule` (999px) est le cas particulier — massivement utilisé mais jamais tokenisé.

Les bordures sont fines (1px) et systématiquement thémées via `--pico-card-border-color`, jamais
codées en dur — c'est ce qui permet aux trois thèmes de rester cohérents. La grille est le seul
endroit où la bordure devient structurelle : chaque cellule en porte une, et c'est elle qui
dessine le quadrillage.

## Components

### Buttons

- **Shape :** coins arrondis doux (10px), hérités de Pico.
- **Primary :** aplat `vert-signal`, texte blanc. Survol vers `vert-signal-survol`.
- **Hover / Focus :** transition courte ; focus visible par un contour net, jamais par une
  simple lueur.
- **Secondary :** variante `secondary` de Pico, retéclée seulement dans le thème rose.

### Chips

- **Style :** pastille compacte dans la barre d'outils (« Aujourd'hui »), typographie Label.
- **State :** désactivée quand on est déjà sur le jour courant — l'état désactivé est visible,
  la pastille ne disparaît pas.

### Cards / Containers

- **Corner Style :** 12px (`md`).
- **Background :** `carte-claire` en clair, `carte-sombre` en sombre, toujours plus contrastée
  que la page.
- **Shadow Strategy :** `--elev-1` au repos (cf. Elevation & Depth).
- **Border :** 1px thémée.
- **Internal Padding :** 10–16px selon la densité du contenu.

### Inputs / Fields

- **Style :** champs Pico, rayon de contrôle 10px, bordure thémée.
- **Focus :** bordure primaire + halo `--pico-primary-focus`.
- **Error :** le message porte `rouge-encre` et un liseré gauche `rouge-alerte` ; le champ
  lui-même n'est pas repeint en rouge.

### Navigation

Il n'y a pas de navigation persistante : un en-tête applicatif (logo + titre + menu ⋯) et une
barre d'outils de date au-dessus de la grille. Les actions secondaires sont regroupées dans le
menu ⋯ pour désencombrer l'en-tête. Un lien d'évitement (« Aller au contenu ») précède tout.

### Grille de planning (composant signature)

Le cœur du produit, et le seul composant qui justifie son propre vocabulaire.

- **Structure :** table à disposition fixe, terrains en colonnes, horaires en lignes.
- **Axes figés :** en-tête (`z-index` 1), colonne des heures (2), coin haut-gauche (3). Le focus
  clavier sur une cellule monte à 4 pour que son contour passe au-dessus des cellules figées.
- **États :** libre (aplat `vert-libre`, cliquable), réservé (rose sourd), club/mien (bleu),
  fermé (gris). Seules les cases libres et club sont interactives.
- **Retour tactile :** `touch-action: manipulation` (pas de délai de tap), survol assombri, et à
  l'appui un liseré interne clair plutôt qu'un `scale` — un `<td>` ne se transforme pas
  proprement.
- **Accessibilité :** les cellules interactives portent `role="button"` et `tabindex`, avec un
  `:focus-visible` en contour vert de 2px posé vers l'intérieur.

## Do's and Don'ts

### Do:

- **Do** réserver le vert à ce qui est jouable ou actionnable (Règle du Vert Actionnable).
- **Do** garder la page plus sombre que les cartes, dans les trois thèmes.
- **Do** faire plier la couleur de marque devant le contraste AA, comme `vert-libre` le fait
  déjà pour le texte blanc des cases.
- **Do** étiqueter tout texte sous 0,75rem par un `title`, un `aria-label` ou un texte
  `sr-only`.
- **Do** figer les deux axes de toute vue tabulaire dense.
- **Do** thémer les bordures par `--pico-card-border-color` plutôt que de coder une couleur.
- **Do** réutiliser les valeurs d'espacement déjà présentes (4, 6, 10, 14, 16, 18px) au lieu
  d'en introduire de nouvelles.
- **Do** traiter les trois thèmes comme égaux : une nouveauté doit être vérifiée en clair, en
  sombre et en rose.

### Don't:

- **Don't** obliger à naviguer pour savoir s'il reste un terrain. La réponse est visible, ou le
  design a échoué. C'est l'anti-référence ResaMania, et c'est la raison d'être du produit.
- **Don't** utiliser l'ombre pour signifier une importance : le relief est ambiant ici, pas
  sémantique.
- **Don't** ajouter un effet de profondeur qui coûte du JavaScript, un flou animé ou un recalcul
  par image (Règle du Coût Nul).
- **Don't** charger une police web. La typographie est celle du système, dans tout le produit.
- **Don't** confondre densité et opacité : une abréviation non étiquetée n'est pas de la
  densité, c'est une devinette.
- **Don't** repeindre un champ en rouge à l'erreur ; le message porte la couleur, pas le champ.
- **Don't** coder une couleur de bordure en dur : elle cassera l'un des trois thèmes.
- **Don't** griser par `opacity` un élément qui porte du texte : l'opacité composite le texte
  et son fond, et effondre un contraste par ailleurs conforme. Utiliser une paire de couleurs
  dédiée, calculée par thème.
- **Don't** peindre un ÉTAT avec l'aplat vert. Un onglet ou un filtre sélectionné se marque
  par le poids et un trait, jamais par le vert plein qui appartient à l'action.
