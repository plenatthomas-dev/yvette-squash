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
  bandeau-info: "#2563eb"
  bandeau-avertissement: "#ea580c"
  bandeau-incident: "#dc2626"
  sunken-clair: "#f4f6f9"
  sunken-sombre: "#12161d"
  sunken-rose: "#ffd5ea"
  live-wash-clair: "#fff8e6"
  live-wash-sombre: "#2a2314"
  live-wash-rose: "#ffe8cf"
  live-edge-clair: "#f0b429"
  live-edge-sombre: "#8a6a1f"
  live-edge-rose: "#d98a2b"
  good-wash-clair: "#eef4fe"
  good-wash-sombre: "#131c29"
  good-wash-rose: "#dfe9fa"
  good-edge-clair: "#3f7ad1"
  good-edge-sombre: "#4a7cc0"
  good-edge-rose: "#4271b8"
  bad-wash-clair: "#fdeeed"
  bad-wash-sombre: "#271515"
  bad-wash-rose: "#ffd7d7"
  bad-edge-clair: "#d9534f"
  bad-edge-sombre: "#b05450"
  bad-edge-rose: "#c25350"
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
  bandeau:
    fontFamily: "system-ui, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, Helvetica, Arial, sans-serif"
    fontSize: "0.95rem"
    fontWeight: 600
    lineHeight: 1.4
  bandeau-icone:
    fontFamily: "system-ui, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, Helvetica, Arial, sans-serif"
    fontSize: "1.15rem"
    fontWeight: 400
  # La rampe de fait, énumérée pour l'outillage — cf. « La rampe de fait » plus bas. Les cinq
  # crans qui portent 63 % des déclarations en rem. Les survivances (0,58 · 0,62 · 0,66 · 0,78 ·
  # 0,88 · 0,92 · 0,95 · 0,98rem) n'y figurent PAS : elles doivent continuer à être signalées.
  scale:
    cran-72: "0.72rem"
    cran-75: "0.75rem"
    cran-80: "0.8rem"
    cran-85: "0.85rem"
    cran-90: "0.9rem"
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
  bandeau-layout:
    textColor: "#ffffff"
    typography: "{typography.bandeau}"
    padding: "12px 16px"
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

- **Vert Signal** (`vert-signal`, `--pico-primary`) : l'unique accent. Boutons primaires,
  contours de focus, cases réservables. Il ne décore jamais.
  **Il n'y a plus qu'UN vert actionnable.** Le produit en a longtemps eu deux, presque
  identiques : un primaire de bouton et un `vert-libre` plus profond, ce dernier ayant seul
  été calculé pour tenir AA. Le texte blanc des boutons restait donc à 3,49:1 — l'arbitrage
  avait été posé et appliqué à un seul des deux endroits. Le primaire a adopté la valeur du
  vert de case : **5,00:1** pour le texte blanc, dans les trois thèmes.
- **Vert Signal Survol** (`vert-signal-survol`) : **le survol assombrit, il n'éclaircit pas.**
  5,41:1. Un survol qui éclaircit rend le libellé moins lisible au moment précis où on touche
  le bouton — c'était le cas en rose, où il tombait à 3,46:1.
- **Vert Signal Encre** (`--primary-fg`) : le vert **quand il porte du texte**, et non quand il
  sert de fond. Deux problèmes distincts : sur un fond, il se lit sous du blanc ; en texte, il
  se lit sur la carte du thème. Le primaire seul y tombait à 3,49:1 en clair et 3,76:1 en rose.
  Décliné par thème — `#12703c` en clair (6,16:1), `#2ea86a` en sombre (5,52:1, éclairci pour
  se détacher de la carte foncée), `#a8005c` en rose (6,21:1).
- **Vert Libre Survol** (`vert-libre-survol`) : survol et appui sur une case libre.

### Secondary

- **Bleu Info** (`bleu-info`) : liseré gauche des encarts d'information, signaux neutres non
  urgents. Jamais utilisé pour une action.
- **Rouge Alerte** (`rouge-alerte`) et **Rouge Encre** (`rouge-encre`) : erreurs et actions
  destructrices. Le liseré et le texte, jamais un aplat de fond.
- **Ambre Avertissement** (`--warn-fg`) : états intermédiaires non bloquants (« non vérifié »).
  Décliné par thème — `#8a4a00` en clair et en rose, `#e0a955` en sombre.
- **Rouge Pastille** (`--badge-bg` / `--badge-fg`, `#d32f2f` / blanc, 4,98:1) : le fond des
  pastilles de compteur (cloche d'alertes, menu ⋯). Paire à part et non `rouge-alerte`, qui est
  une teinte de **liseré** : elle ne tenait que 3,91:1 en clair et 2,78:1 en sombre sous un
  chiffre de ~10px, où aucune exemption de contraste ne s'applique. Déclarée une fois et héritée
  par les trois thèmes : la pastille reste à ≥3:1 de sa carte partout (4,98 clair / 3,36 sombre
  / 4,15 rose). Un compteur d'alertes est un signal, pas une couleur de marque — il n'a pas à
  se décliner.

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
- **Filet de Grille** (`--grid-line`) : la couleur du quadrillage de la grille de planning, et
  d'elle seule. Décliné par thème — `#9aa2ae` clair, `#434b58` sombre, `#c98aa8` rose. Voir la
  Règle du Filet Partagé ci-dessous : ce jeton ne vise délibérément pas 3:1.
- **Creux** (`--sunken`) : la surface d'une vignette posée sur une carte. Elle s'ENFONCE sous la
  carte au lieu de flotter au-dessus — `#f4f6f9` clair, `#12161d` sombre, `#ffd5ea` rose. En
  sombre elle se place ENTRE la page et la carte, la carte y étant la plus claire des trois.
  Mesuré : texte 15,75:1 (clair) · 14,09:1 (sombre) · 12,96:1 (rose) ; secondaire ≥ 4,95:1
  partout. Voir la Règle de la Carte sur Carte ci-dessous.

### Voile d'état

Une seule famille de couleurs peint un ÉTAT au niveau d'une ligne entière, et c'est délibéré :
« en cours » est le seul état qui demande qu'on regarde MAINTENANT. « À venir » et « terminée »
n'ont rien d'urgent à dire et se lisent à leur pastille.

- **Voile En Cours** (`--live-wash`) et **Bord En Cours** (`--live-edge`) : `#fff8e6`/`#f0b429`
  clair, `#2a2314`/`#8a6a1f` sombre, `#ffe8cf`/`#d98a2b` rose. Le voile est de la même famille
  ambre que la pastille « en cours », assez pâle pour rester un fond : texte 16,09:1 (clair) ·
  12,10:1 (sombre) · 14,37:1 (rose). En thème rose il garde sa teinte ambre — c'est précisément
  son écart avec le rose ambiant qui le rend repérable.

### Issue : ce qui s'est bien passé, ce qui s'est mal passé

Deux familles de plus, **bleu** et **rouge**, pour dire l'issue d'une chose finie — une rencontre
gagnée ou perdue, une disponibilité donnée ou refusée. L'ambre du voile d'état tient le troisième
cas, « entre les deux » : nul, incertain.

- **Voile Favorable** (`--good-wash`) et **Bord Favorable** (`--good-edge`) : `#eef4fe`/`#3f7ad1`
  clair, `#131c29`/`#4a7cc0` sombre, `#dfe9fa`/`#4271b8` rose.
- **Voile Défavorable** (`--bad-wash`) et **Bord Défavorable** (`--bad-edge`) : `#fdeeed`/`#d9534f`
  clair, `#271515`/`#b05450` sombre, `#ffd7d7`/`#c25350` rose.

**Bleu et non vert pour « gagné ».** C'est la Règle du Vert Actionnable appliquée là où elle
coûte quelque chose : une victoire est le résultat le plus positif du produit, et c'est
exactement ce qui rend tentant de la peindre en vert. Mais elle n'est pas un bouton — on ne
clique pas sur une victoire. Le bleu ne porte aucune autre charge dans ce vocabulaire, il est
donc libre.

**Le voile pleine ligne reste réservé à « en cours ».** L'issue d'une rencontre se dit par un
FILET à gauche et par la couleur du score, jamais par un fond. Peindre les lignes terminées
donnerait de la concurrence au seul état qui demande qu'on regarde maintenant, et le viderait de
son sens — une liste de saison est presque entièrement faite de rencontres terminées.

L'exception est le bloc de **disponibilités**, où le fond porte l'état : il ne s'affiche que sur
une rencontre à venir, donc aucun voile « en cours » ne peut y entrer en concurrence, et on y
balaie une liste de noms à l'œil plutôt qu'on ne la lit ligne à ligne.

### Couleurs volontairement hors thème

Deux paires échappent au système, et c'est délibéré. Toutes deux fixent **fond ET texte
ensemble**, elles rendent donc à l'identique sur les trois thèmes — contrairement à une
couleur de texte posée seule, qui suit le fond du thème et finit par échouer au contraste.

- **Vert WhatsApp** (`#25d366` / texte `#073b26`, 6,37:1) : bouton de lien vers le groupe.
  C'est une couleur de marque ; un bouton WhatsApp doit ressembler à WhatsApp partout.
- **Pastille « en cours »** (`#fcd34d` / texte `#78350f`, 6,29:1) : ambre pleine, choisie
  précisément parce qu'elle reste lisible en clair, en sombre et en rose, là où l'ancien gris
  muet ne l'était pas.

**La Règle de la Paire Complète.** Une couleur hors thème n'est acceptable que si elle
définit son fond ET son texte. Poser une seule des deux fait suivre l'autre au thème et
produit un échec de contraste dans au moins un des trois — c'est exactement ce qui est arrivé
aux libellés d'état de l'admin (2,59:1 en sombre).

### Bandeaux de layout

Deux bandeaux vivent tout en haut de l'appli, hors de la page : maintenance et annonce. Ils
s'adressent à quelqu'un qui ne les a pas demandés et qui doit les comprendre **sans les lire
en entier** — d'où un vocabulaire de couleurs pleines, texte blanc, appliqué de façon stricte :

- **`bandeau-info`** (`#2563eb`) : une information, rien n'est cassé. Annonce du bureau.
- **`bandeau-avertissement`** (`#ea580c`) : une annonce que le bureau a marquée comme
  importante (`level: "warn"`).
- **`bandeau-incident`** (`#dc2626`) : l'appli est dégradée maintenant — base injoignable.

Ils suivent la **Règle de la Paire Complète** : fond plein + texte blanc figés ensemble, donc
identiques dans les trois thèmes. C'est voulu — un incident ne doit pas changer d'allure selon
le thème du lecteur.

**Pourquoi une typographie à eux** (`bandeau`, 0,95rem / 600, et `bandeau-icone`, 1,15rem).
Un bandeau n'est ni du corps de texte ni un titre : légèrement sous le corps pour ne pas
concurrencer la page qu'il surmonte, mais en demi-gras pour rester lisible d'un coup d'œil.
L'emoji de tête est monté à 1,15rem parce qu'à taille de texte il se perd.

**La Règle du Bandeau Muet.** Un bandeau ne s'affiche que s'il apporte quelque chose que
l'utilisateur ne peut ni déduire de l'écran, ni obtenir sans lui. Un bandeau qui demande une
action que l'appli sait faire seule est un bandeau de trop.

Cas d'application : les mises à jour. Un onglet resté ouvert pendant un déploiement tourne sur
du code périmé, et l'évidence serait de le signaler avec un bandeau « nouvelle version, cliquez
pour recharger ». On ne le fait pas — l'appli recharge d'elle-même dès que c'est sans danger
(cf. `components/UpdateReloader`). Il n'y a rien à annoncer : soit la mise à jour peut se faire
et elle se fait, soit une saisie est en cours et on attend qu'elle finisse. Dans les deux cas,
un bandeau n'aurait fait que déplacer sur l'utilisateur un arbitrage qui ne le regarde pas.

### Named Rules

**La Règle du Vert Actionnable.** Le vert ne se pose que sur ce qu'on peut toucher : un bouton
primaire, une case libre, un contour de focus. Un élément vert non actionnable est une faute, et
elle se repère à l'œil nu sur une capture d'écran.

**La Règle du Fond Toujours Plus Sombre.** Quel que soit le thème, la page est plus sombre que
les cartes en clair, et plus sombre que tout en sombre. Une carte qui se confond avec sa page a
cassé le système, même si son ombre est intacte.

**La Règle du Contraste Avant la Marque.** Quand la couleur de marque ne passe pas le seuil AA
sur une surface, c'est la couleur qui plie. Le vert du produit a été approfondi pour cette
raison, d'abord sur les cases puis — trop tard — sur les boutons.

**La Règle du Fond et de l'Encre.** Une même couleur de marque a besoin de DEUX valeurs : une
pour servir de fond sous du texte clair, une pour être elle-même du texte sur la carte du thème.
Les deux ne coïncident presque jamais. Chaque fois que le produit a réutilisé une valeur de fond
comme couleur de texte, il a échoué au contraste — le primaire en texte (3,49:1), les pastilles
de compteur (2,78:1). D'où les paires `--pico-primary`/`--primary-fg` et `--badge-bg`/`--badge-fg`,
sur le modèle de `--past`/`--past-fg` qui existait déjà.

**La Règle du Filet Partagé.** Le quadrillage de la grille ne peut pas atteindre 3:1, et c'est
un fait géométrique, pas un renoncement. `border-collapse: collapse` fait **partager un seul
filet** entre deux cellules voisines, et la grille juxtapose un remplissage très sombre (le vert
des cases libres) et des remplissages très pâles. Aucune couleur unique ne tient 3:1 contre les
deux : le seul optimum est le point où les deux contrastes s'égalisent, soit **≈2,0:1**. C'est
ce point qui est retenu dans les trois thèmes. Ne pas « corriger » ce chiffre vers le haut : le
remonter d'un côté l'effondre de l'autre. L'état antérieur — filet hérité de la couleur de carte,
donc 1,03:1 en clair et 1,07:1 en sombre sur cinq états sur six — était le vrai défaut.

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

### La rampe de fait

Entre les rôles nommés et les vingt-cinq valeurs réelles, il existe une **rampe de fait** :
cinq crans qui portent, à eux seuls, **108 des 172 déclarations en `rem`** de la feuille
(63 %). Elle n'a jamais été décidée, elle s'est formée — mais elle est aujourd'hui le système
réel du texte secondaire, et l'ignorer revient à inventer une valeur de plus à chaque écran.

| Cran | Emplois | Ce qu'il porte |
|---|---|---|
| **0,72rem** | 23 | pastilles, sigles, en-têtes de colonnes serrées |
| **0,75rem** | 8 | petits boutons, pastilles d'état |
| **0,80rem** | 32 | texte secondaire courant : dates, mentions, tableaux denses |
| **0,85rem** | 31 | texte d'appoint lisible : encarts, libellés d'outils |
| **0,90rem** | 14 | texte d'appoint appuyé, titres de blocs repliés |

Les huit valeurs restantes (0,58 · 0,62 · 0,66 · 0,78 · 0,88 · 0,92 · 0,95 · 0,98rem) sont des
survivances, pas des crans : elles n'apparaissent qu'une poignée de fois chacune et **ne
doivent pas servir de précédent**.

### Named Rules

**La Règle du Micro Étiqueté.** En dessous de 0,75rem, un texte doit être soit un chiffre, soit
accompagné d'un libellé accessible (`title`, `aria-label`, ou texte `sr-only`). La densité se
gagne par l'étiquetage, jamais en supposant que le lecteur sait déjà.

**La Règle du Cran Voisin.** Une nouvelle taille se prend dans la rampe de fait (0,72 · 0,75 ·
0,80 · 0,85 · 0,90rem), jamais entre deux crans. Un écart de deux centièmes de `rem` ne se voit
pas — et c'est précisément le problème : il ne se lit pas comme un système, il se lit comme une
inattention. Deux éléments du même dispositif (deux pastilles, deux en-têtes) prennent le même
cran, pas deux crans voisins.

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

**La Règle de la Carte sur Carte.** Une liste d'éléments posée sur une carte ne se sépare pas
en donnant une carte à chaque élément : deux surfaces de même valeur, si bien ombrées soient-
elles, ne se distinguent pas l'une de l'autre. L'élément s'ENFONCE (`--sunken`) au lieu de
flotter. C'est le corollaire de la Règle du Fond Toujours Plus Sombre appliqué vers l'intérieur,
et il vaut dans les trois thèmes — en sombre, « s'enfoncer » veut dire aller vers la page, donc
vers le plus foncé, alors que la carte y est la plus claire des trois surfaces.

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

### Onglets de filtre

- **Style :** texte seul sur fond nu, séparés du contenu par un filet de 1px. L'onglet actif se
  marque au **poids** (700 contre 500) et à un **trait** de 2px sous lui, posé en `box-shadow`
  interne plutôt qu'en `border-bottom` pour ne pas décaler la ligne de base entre l'actif et les
  autres.
- **Couleur :** jamais d'aplat. Le trait reprend `--pico-contrast`, l'encre du thème — voir la
  Règle du Vert Actionnable : un filtre sélectionné est un ÉTAT, et le vert appartient à
  l'action.
- **Débordement :** la barre défile horizontalement (`overflow-x: auto`, ascenseur masqué) : le
  nombre d'équipes n'est pas borné, et une barre d'onglets ne doit jamais passer à la ligne.
- **Accessibilité :** `role="tablist"` complet — flèches gauche/droite, Home/End, `tabIndex`
  roulant (un seul onglet dans l'ordre de tabulation), `aria-controls` vers le panneau.

### Pastilles d'état

Le vocabulaire des états d'une rencontre ou d'un match. **Trois états, trois traitements
franchement différents** — c'est la propriété qui compte, et elle se vérifie sur une capture en
niveaux de gris.

- **À venir / à saisir :** contour seul, fond transparent, encre sourdine. Rien n'a commencé.
- **En cours :** ambre plein (`#fcd34d` sur `#78350f`, 6,29:1), la paire hors thème déjà
  documentée plus haut. Seul état à peindre aussi la ligne entière (voile `--live-wash`).
- **Terminée :** gris plein, la paire `passe`/`passe-encre` — celle du créneau écoulé, dont
  c'est exactement le sens. Sans bordure, pour se distinguer du contour de « à venir ».

**La Règle des Trois Traitements.** Deux états qui partagent le même traitement visuel ne sont
pas deux états. « À venir » et « terminée » ont longtemps porté la même pastille sourdine : la
liste n'en distinguait donc que deux sur trois, et le seul moyen de savoir était de lire.
Contour, aplat vif, aplat sourd : trois formes, pas trois nuances d'une même forme.

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
- **Quadrillage :** c'est le seul endroit où la bordure devient structurelle — chaque cellule en
  porte une, et c'est elle qui dessine la grille. Elle a donc son jeton propre, `--grid-line`, et
  non le jeton de bordure de carte, qui s'efface en thème sombre. Cf. la Règle du Filet Partagé
  pour la raison pour laquelle son contraste plafonne à ≈2,0:1.
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
- **Do** faire plier la couleur de marque devant le contraste AA, comme le vert du produit le
  fait pour le texte blanc des boutons et des cases.
- **Do** donner à toute couleur de marque une valeur de FOND et une valeur d'ENCRE distinctes
  avant de l'utiliser en texte (Règle du Fond et de l'Encre).
- **Do** enfoncer (`--sunken`) les éléments d'une liste posée sur une carte, plutôt que de leur
  donner une carte à eux (Règle de la Carte sur Carte).
- **Do** distinguer des états par la FORME du traitement — contour, aplat vif, aplat sourd — et
  non par trois nuances d'une même forme (Règle des Trois Traitements).
- **Do** étiqueter tout texte sous 0,75rem par un `title`, un `aria-label` ou un texte
  `sr-only`.
- **Do** figer les deux axes de toute vue tabulaire dense.
- **Do** thémer les bordures par `--pico-card-border-color` plutôt que de coder une couleur —
  **sauf quand la bordure porte du sens.** Pico redéfinit ce jeton en *couleur de carte* sous
  thème sombre (`pico.css:448` et `583`) : une bordure décorative y disparaît sans dommage, mais
  une bordure structurelle disparaît aussi. C'est ce qui a effacé le quadrillage de la grille,
  qui a désormais son propre jeton `--grid-line`.
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
- **Don't** peindre une ligne entière pour un état qui n'a rien d'urgent à dire. Seul « en
  cours » le mérite ; un accent plein sur un état inactif est du bruit.
