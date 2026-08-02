---
target: src/app/page.tsx
total_score: 22
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 3
timestamp: 2026-08-01T22-28-23Z
slug: src-app-page-tsx
---
Method: dual-agent (A: revue de design isolée · B: détecteur + preuves déterministes)

## Design Health Score

| # | Heuristique | Note | Problème clé |
|---|---|---|---|
| 1 | Visibilité de l'état du système | 2 | `busy` est piloté partout mais rendu nulle part : la réservation est muette de bout en bout |
| 2 | Correspondance système / monde réel | 3 | Vocabulaire de joueur, mais `Erreur ${res.status}` fuit en 4 endroits |
| 3 | Contrôle et liberté | 3 | Confirmations solides ; toasts d'erreur irrécupérables (3,5 s, `pointer-events: none`) |
| 4 | Cohérence et standards | 2 | 3 patrons de popup divergents ; 2 `window.prompt()` dans une base qui a banni `confirm()` |
| 5 | Prévention des erreurs | 3 | Règle « un seul terrain par horaire » portée 4 fois, en amont du geste |
| 6 | Reconnaissance plutôt que rappel | 2 | Légende cachée derrière une icône ; « gauche/droite = quel terrain » n'existe qu'en commentaire |
| 7 | Flexibilité et efficacité | 3 | Sélection multiple réelle, mais aucune navigation clavier dans la grille |
| 8 | Esthétique et minimalisme | 1 | 250–350 px de châssis avant la première ligne de grille sur iPhone SE |
| 9 | Reconnaître, diagnostiquer, réparer | 1 | Le diagnostic par créneau est calculé puis jeté ; erreurs en `aria-live="polite"` |
| 10 | Aide et documentation | 2 | Aucune aide contextuelle hors la légende masquée |
| **Total** | | **22/40** | **Acceptable — améliorations significatives requises** |

## Design Specificity Verdict

**Noyau très spécifique, châssis générique — et le châssis étouffe le noyau.**

Irremplaçable et ancré dans ce produit : la case bicolore de la vue semaine (un `<td>` = un créneau, deux `<span>` = les deux terrains, cliquables séparément) ; la règle « un seul terrain par horaire » rendue en sémantique radio et pré-vérifiée avant le dialogue ; `defaultOpenDate()` qui ouvre sur demain après 21 h ; le même bleu pour « asso » et « le mien » distingués par la seule étoile ; le thème Short Rose et le jingle de confirmation.

Interchangeable : tout ce qui est au-dessus de la grille. Quatre bandes de contrôles Pico empilées, indiscernables, qui ne disent rien du squash. Sur iPhone SE, 250 à 350 px sont consommés avant la première ligne de grille à 46 px — la grille, « le produit » selon PRODUCT.md, obtient quatre lignes visibles. L'anti-référence ResaMania est « obliger à naviguer pour savoir s'il reste un terrain » ; ici on oblige à scroller, ce qui est la même défaite avec un geste différent.

**Scan déterministe.** `detect.mjs --json src/app/page.tsx` → `[]`, exit 0. Ce résultat est un artefact de portée, pas une preuve de qualité : `page.tsx` ne contient aucune couleur codée en dur et un seul style inline ; tout son style vit dans `globals.css`, lié depuis `layout.tsx`. Scan élargi à `src/app src/components` → **133 trouvailles** (125 advisory, 8 warning) : `design-system-font-size` 79, `design-system-color` 24, `design-system-radius` 22, `side-tab` 8. Sur les 8 `side-tab`, 7 sont des faux positifs (bandes de sévérité des toasts, marqueurs « cette ligne est la mienne ») ; seule `.notice` correspond à l'anti-patron visé.

**Overlays visuels : aucun.** Étape navigateur volontairement ignorée — le `.env` local pointe vers la base de production Neon (plan gratuit, quota déjà épuisé le mois dernier), et un serveur de dev l'aurait maintenue éveillée. Aucune mesure de DOM rendu n'est revendiquée : tous les chiffres viennent de la lecture des sources.

## Overall Impression

Le cœur métier est le travail d'un auteur qui connaît son domaine : la contrainte ResaMania encodée en interaction plutôt qu'en message d'erreur, le rappel du délégant à l'instant du geste, la continuité du logo entre splash et login. Ce sont des choix qu'on ne fait pas par accident.

Le problème est que ce cœur est enveloppé dans une couche générique qui lui prend la place, et qu'il devient muet dès qu'il agit. La plus grande opportunité n'est pas d'embellir : c'est de rendre visible ce que l'appli fait pendant qu'elle le fait, et de rendre à la grille les pixels que le châssis lui prend.

## What's Working

**La prévention d'erreur encode le domaine.** Le contrôle « tu joues déjà sur Squash 1 à cet horaire » se déclenche avant l'ouverture du dialogue, et la règle est portée quatre fois, partout où elle peut être violée. Une contrainte de l'amont est devenue une propriété de l'interface : le membre ne rencontre jamais le refus de ResaMania, il rencontre une explication en français avant d'avoir cliqué.

**Le mode délégation est rappelé au geste, pas au choix.** Le titre du dialogue est réécrit avec le prénom réel à chaque action. L'erreur de mode ne se prévient pas en affichant un état quelque part, elle se prévient en le redisant à l'instant de l'engagement.

**La palette d'états de la grille passe AA dans les trois thèmes** — 5,00:1, 5,64:1, 6,40:1 en clair ; 4,86 à 9,35:1 en sombre ; 5,14 à 5,68:1 en rose. La « Règle du Contraste Avant la Marque » de DESIGN.md n'est pas une intention : elle est mesurable dans le code.

## Priority Issues

### [P0] La réservation est muette pendant tout son déroulement
`busy` est piloté à six endroits de `page.tsx` mais n'apparaît dans aucun JSX. Entre le tap sur « Réserver » et le toast, l'appel traverse l'API interne ResaMania sans un pixel de mouvement. `onBookMany` enchaîne N appels séquentiels, écran figé. Le garde `if (busy || confirmState) return` avale les re-taps en silence.

**Pourquoi ça compte.** Debout, en 4G, deux à quatre secondes d'écran immobile se lisent « ça n'a pas marché ». Le membre re-tape, rien ne répond, la défiance s'installe — sur un outil associatif sans support.

**Fix.** Passer `busy` aux grilles ; case engagée en point pulsant + `pointer-events: none`. Barre de progression réelle « Réservation 3 / 7… » pour le groupé (le compteur existe déjà). Un `role="status"` dédié au verbe en cours.

**Commande :** `/impeccable harden`

### [P0] Deux barres fixes se recouvrent : « Réserver » est masqué ou détourné
`.wk-actionbar` est en `z-index: 50`, `.install-banner` en `z-index: 900`, toutes deux `position: fixed; bottom: 0`. Sur iOS Safari la bannière s'affiche immédiatement et persiste 14 jours.

**Pourquoi ça compte.** Nouveau membre, iPhone, arrivé par le QR code du vestiaire : il coche trois créneaux et le bouton qui valide son geste est recouvert. Sur Android en mode `prompt`, un tap dans la zone recouverte déclenche l'installation PWA **au lieu** de la réservation — un geste qui produit silencieusement le mauvais résultat.

**Fix.** Masquer `.install-banner` tant que `selMode && selected.size > 0` ; ne pas monter le prompt d'installation dans les 60 premières secondes ; décaler `.toasts` de la hauteur de la barre active.

**Commande :** `/impeccable adapt`

### [P1] Le point de rupture à 560 px s'inverse : la tablette est moins bien traitée que le téléphone
`table.planning.week` reçoit `min-width: 660px` **uniquement** sous 560 px, et `.wk-cell` passe à 46 px de haut dans ce seul bloc. Au-dessus, la table cesse de défiler et comprime 7 jours × 2 terrains dans la largeur disponible.

| Viewport | Segment (L × H) | Défile |
|---|---|---|
| 560 px | 41,3 × 46 | oui |
| **561 px** | **31,2 × 42** | non |
| 740 px | 44,0 × 42 | non |

**Pourquoi ça compte.** Un pixel de croissance fait perdre 25 % de largeur de cible et la hauteur confortable. Toute la bande 561–740 px — petites tablettes, écran partagé, téléphone en paysage — reçoit les pires cibles de l'appli, pires que la disposition mobile que le point de rupture était censé protéger. La hauteur ne revient jamais à 44 px au-delà de 560 px.

**Fix.** Sortir `min-width` et la hauteur de cellule du bloc mobile : appliquer `min-width: 660px` et `height: 46px` par défaut, et ne les relâcher qu'au-delà de ~760 px où la largeur naturelle repasse le seuil.

**Commande :** `/impeccable adapt`

### [P1] L'échec groupé calcule le diagnostic puis le jette
`fails[]` accumule une ligne par créneau raté (`mer. 1 juil. 19:00 : <raison>`). En succès partiel, seul le compte est affiché ; en échec total, seul `fails[0]`. Le tout dans un toast de 3,5 s, intappable, en `aria-live="polite"`. `exitSel()` a déjà vidé la sélection.

**Pourquoi ça compte.** Un membre qui bloque cinq créneaux pour un tournoi et en obtient trois doit savoir lesquels. L'information existait, elle a été calculée, elle a été détruite.

**Fix.** Remplacer le toast de bilan par un `ConfirmDialog` de résultat réutilisant son champ `lines` déjà existant : titre « 3 réservées, 2 échouées », `lines = fails`, bouton « Compris ». Zéro nouveau composant. Et garder cochés les créneaux qui ont raté.

**Commande :** `/impeccable harden`

### [P1] `td.cell.past` échoue au contraste dans les trois thèmes
`opacity: 0.55` composite à la fois le texte et le fond, effondrant une paire par ailleurs conforme (4,6–5,2:1) à **2,09:1 en clair, 2,39:1 en sombre, 2,28:1 en rose**. Deux quasi-échecs s'y ajoutent en thème sombre : texte secondaire à 4,44:1 et `.notice` à 4,18:1 (seuil 4,5), qui touchent tout le texte secondaire et pas seulement la grille. Et le placeholder du thème rose est à 2,48:1.

**Pourquoi ça compte.** PRODUCT.md engage sur des membres de tous âges. Les créneaux passés restent lisibles pour un œil jeune sur un bon écran ; ils disparaissent au soleil, sur un écran usé, ou pour un presbyte — c'est-à-dire exactement la population que la contrainte visait.

**Fix.** Remplacer `opacity` par une paire de couleurs dédiée `--past` / `--past-fg` calculée par thème pour tenir 4,5:1. Remonter le muted sombre de `#7b8495` à ~`#8b94a5`.

**Commande :** `/impeccable audit`

## Vos propres règles, enfreintes

DESIGN.md a été écrit il y a une heure ; trois de ses six règles nommées sont déjà contredites par le code existant.

- **Règle du Vert Actionnable** — trois familles de contrôles peignent leur état actif avec `var(--pico-primary)`. Au chargement par défaut, deux pastilles vertes non actionnables (« Journée », « Jour ») sont allumées au-dessus d'une grille dont les cases vertes sont, elles, les seules choses à toucher. La règle dit : « une faute qui se repère à l'œil nu sur une capture d'écran ». Elle s'y repère.
- **Règle du Micro Étiqueté** — `.t-end` (0,66 rem, `opacity: 0.65`) affiche une heure de fin nue, sans `title`, sans `aria-label`, sans `sr-only`, dans un `<th>` lui-même non titré en vue jour. Elle passe par l'échappatoire « un chiffre » sur un pur technicisme tout en trahissant l'intention. Tous les autres micro-textes sont conformes, vérification faite.
- **Règle des Deux Axes** — `role="button"` sur les `<td>` fait cesser aux cellules d'être des cellules : le lecteur d'écran n'annonce plus « ligne 19:00, colonne Squash 2 ». Le travail le plus soigné du système visuel (axes figés, coin haut-gauche au-dessus des deux) est littéralement inaccessible à qui ne voit pas. Aucun `scope` sur les `<th>`, pas de `<caption>`.
- **Règle du Coût Nul** — respectée. Aucune violation trouvée.

## Persona Red Flags

**Casey (mobile, une main, interrompu).** La pastille 🕒 de liste d'attente : `padding: 1px 6px`, `font-size: .6rem` → **~17 px de haut**, collée au bord d'un conteneur qui défile horizontalement. Les deux agents l'ont trouvée indépendamment. La même fonction est un bouton confortable en vue Semaine — Casey ne peut pas deviner qu'il faut changer de vue pour obtenir une cible tappable. Le ✕ des bandeaux : 24 × 24. Le 📅 d'export : ~33 × 27, à 8 px du bouton « Annuler ». Le rechargement au retour d'onglet repeint la grille sans aucun signal : Casey tape à l'emplacement mémorisé, la case a changé, le tap est avalé. `.journal li:hover { translateY(-4px) }` reste collé après le tap sur tactile.

**Jordan (novice).** Trois interruptions avant la grille au premier lancement : modale d'annonce, encart biométrie, bannière d'installation — aucune ne concerne sa tâche. Trois icônes non étiquetées côte à côte dans la `viewbar`, dont la sélection multiple, la fonction la plus puissante et la moins devinable. La légende est cachée derrière l'une d'elles : Jordan voit du rose et du bleu et n'a aucun moyen de savoir que le bleu signifie « quelqu'un de l'asso, tu peux te joindre » — c'est-à-dire précisément l'apport n°2 revendiqué face à ResaMania, invisible pour qui ne trouve pas le ⓘ. La case fermée est un rectangle gris sans texte, sans `title`, sans `aria-label` : fermé, en panne, ou en chargement ?

**Sam (lecteur d'écran / clavier).** Aucune navigation clavier dans la grille : jusqu'à **40 arrêts de tabulation** en vue jour, **280 segments** en vue semaine, tous `tabIndex={0}`. `role="menu"` déclaré sans le patron menu (pas de flèches, pas de focus déplacé, pas de retour au déclencheur) — un rôle ARIA qui ment est pire que pas de rôle. `LegendInfo` est un `role="dialog"` sans Échap ni piège de focus. Toutes les erreurs passent en `role="status"` poli et sont retirées du DOM après 3,5 s. Et les flèches mentent en vue semaine : `aria-label="Jour précédent"` alors que le handler recule de sept jours — correction d'une ligne.

## Minor Observations

1. `<h1 class="sr-only">` suivi d'un `<img alt="Squash de l'Yvette">` : le nom est annoncé deux fois. Mettre `alt=""` sur le logo décoratif (3 endroits).
2. Présences tronquées à 4 lettres, liste complète dans un `title` — inexistant au doigt. La couche sociale devient illisible exactement quand elle devient intéressante (3+ personnes).
3. Trois graphies pour la même fonction d'aide : `InfoIcon` SVG deux fois, un caractère « i » dans un bouton la troisième.
4. Le menu dit « Tricount » (marque tierce) là où PRODUCT.md, le code et les commentaires disent « Frais ».
5. Six « commentaires » CSS ouverts par `\*` au lieu de `/*` : ce sont des déclarations invalides que le parseur jette.
6. La `viewbar` reste montée en vues Frais/Tournoi, avec Jour ou Semaine allumé en vert au-dessus d'un module qui n'a ni jour ni semaine.
7. `.toasts` sans `max-height` : trois échecs simultanés empilent trois toasts par-dessus les deux barres fixes.
8. « Le Complexe, Bures » répété à chaque chargement, pour un lieu invariant. ~20 px rendus à la grille.
9. Trois transitions animant `transform` échappent à `prefers-reduced-motion` (`.filters button`, `.journal li` à -4 px, `.passkey-fab` en `scale(0.94)`). Le commentaire du code assume la décision pour les transitions courtes — l'argument tient pour `background`, il est plus faible pour un déplacement.

## Questions to Consider

1. **Si l'écran s'ouvrait directement sur la grille — sans en-tête, sans les trois barres — qu'est-ce qui manquerait vraiment ?** Combien de membres ont réellement touché « Matin » ou « Après-midi » ce mois-ci ? Si la réponse est « presque personne », vous récupérez 50 px de grille et un point de décision à 4 options.
2. **Pourquoi la question centrale du produit n'a-t-elle pas de réponse en toutes lettres ?** Une ligne : « Ce soir : 3 créneaux libres à partir de 19 h », calculée sur les données déjà chargées, coût base nul. Aujourd'hui le produit exige de savoir lire une matrice colorée là où ResaMania exige de naviguer. C'est mieux, mais c'est le même type de dette.
3. **La vue Semaine et la vue Jour ne sont-elles pas la même vue à deux zooms ?** Deux composants, deux modèles de sélection, deux interactions de liste d'attente, deux modèles de détail. Tenir l'invariant « une case = un créneau, un segment = un terrain » dans les deux ferait disparaître la moitié du vocabulaire d'interaction sans rien perdre.
4. **Et si les toasts n'existaient plus ?** Le succès pourrait s'écrire là où il a lieu : la case passe au bleu sous le doigt, le jingle joue. L'échec mérite l'inverse : rester jusqu'à ce qu'on l'ait vu. Le toast sert les deux et est mal calibré pour les deux.
5. **Sur quel appareil réel avez-vous essayé de réserver trois créneaux au pouce, en 4G, en Safari iOS, sans avoir masqué la bannière d'installation ?** La superposition `z-index` survit dans le code parce que ce parcours n'a jamais été joué en entier sur un vrai téléphone.
