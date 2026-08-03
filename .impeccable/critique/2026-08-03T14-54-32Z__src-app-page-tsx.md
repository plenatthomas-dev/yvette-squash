---
target: src/app/page.tsx
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 4
timestamp: 2026-08-03T14-54-32Z
slug: src-app-page-tsx
---
Method: dual-agent (A : revue de design isolée · B : détecteur + preuves déterministes)

## Design Health Score

| # | Heuristique | Note | Problème clé |
|---|---|---|---|
| 1 | Visibilité de l'état du système | 3 | Excellent *pendant* l'action (`pendingIds`, progression « 3 / 7 ») ; après le succès, `reload(true)` n'est pas attendu et `pendingIds` est vidé dans le `finally` (`page.tsx:627-635`) → la case réservée redevient verte sous un toast « Réservation confirmée » |
| 2 | Correspondance système / monde réel | 3 | Le tableau terrains × horaires EST le panneau du club ; mais `Erreur ${pr.status}` remonte brut (`page.tsx:404`), interdit par `PRODUCT.md:129-130` |
| 3 | Contrôle et liberté | 3 | Échap + piège de focus via `useDialog` sur 11 modales ; **3 modales revendiquent `aria-modal` sans rien tenir** |
| 4 | Cohérence et standards | 2 | Le projet écrit de bonnes règles et ne les applique qu'à un endroit sur deux (détail en Impression générale) ; `.warn` inerte ; deux langages de carte |
| 5 | Prévention des erreurs | 3 | Désamorçage de l'erreur de 21 h, détection de conflit avant appel, confirmation nommant terrain + heure + date longue |
| 6 | Reconnaissance plutôt que rappel | 2 | 5 des 8 états sans légende ; 3 icônes non étiquetées mitoyennes ; **14 champs dont le seul libellé est un `placeholder`** |
| 7 | Flexibilité et efficacité | 3 | Navigation clavier tableur dans la grille, sélection multiple, état dans l'URL, export .ics ; mais le sélecteur de date est inatteignable au clavier |
| 8 | Esthétique et minimalisme | 2 | 17 contrôles en 4 rangées avant le premier créneau, + 4 bandeaux masquables + 2 surcouches fixes |
| 9 | Récupération d'erreur | 2 | Le bilan de groupé partiel est remarquable ; l'échec unitaire n'a qu'un toast de 3,5 s, et la panne de chargement ne laisse aucun bouton « Réessayer » |
| 10 | Aide et documentation | 2 | Légende partielle (3 états sur 8) derrière une icône non étiquetée ; « 🕒 », « ★ », « 👥 » jamais expliqués à l'écran |
| **Total** | | **25/40** | **Compétent, trous nets** (moitié basse de la bande 24-32) |

Aucune note n'a bougé sur les preuves de B : son scan a **corroboré** le jugement de A plutôt que de le déplacer. Il a en revanche considérablement élargi l'assiette des heuristiques 4 et 6.

## Verdict de spécificité du design

**Évaluation non ancrée (A).** Ce produit est **spécifique dans ses règles et générique dans sa forme**. La logique métier est indiscutablement celle d'un club de squash : un seul terrain par horaire parce que ResaMania le refuse (`PlanningGrid.tsx:174-175`), la bascule sur demain après 21 h parce qu'il ne reste plus rien à jouer le soir même (`page.tsx:56-62`), le « +1 » sur le créneau d'un autre membre parce qu'on se connaît (`page.tsx:704-749`), la liste d'attente avec le rang, le thème « Short Rose ». Aucun outil générique n'a ces règles. **Mais retirez les mots et il ne reste rien qui appartienne à ce club** : Pico par défaut, pile système, pastilles grises de 0,85 rem, `<table>` à fond pastel. Un logiciel de salles de réunion reprendrait cette composition sans changer une ligne de CSS.

Deux occasions manquées dominent :

1. **Le club a exactement deux terrains** (`globals.css:2426` : `grid-template-columns: 66px 1fr 1fr`). Deux terrains côte à côte, c'est un **lieu**. La vue Semaine l'a compris et a inventé la case bicolore (`globals.css:2147-2155`) — la seule composition véritablement propre à ce produit dans tout le dépôt. La vue Jour, qui est la surface principale, l'ignore et reste un tableau à *n* colonnes.
2. **La réponse n'est jamais dite.** `PRODUCT.md:34-36` définit la réussite comme « obtenir la réponse à *est-ce qu'il y a un terrain ce soir ?* en un coup d'œil ». L'appli affiche une grille et laisse compter le vert. Nulle part une phrase du type « 3 créneaux libres ce soir ».

**Scan déterministe (B).** `detect.mjs --json src` → code de sortie 2, **127 trouvailles sur 4 règles**, sortie complète non tronquée.

| Règle | Sévérité | Occurrences | Verdict après tri |
|---|---|---|---|
| `design-system-font-size` | advisory | 83 | **Dette connue** (19 valeurs distinctes) — moins ~9 faux positifs |
| `design-system-color` | advisory | 25 | **Mixte** : 1 vrai défaut, 9 faux positifs d'ombres, brand externe |
| `design-system-radius` | advisory | 11 | **Dette connue**, déjà arbitrée |
| `side-tab` | **warning** | 8 | **7/8 faux positifs sémantiques**, 1 vrai défaut mineur |

Le tri compte autant que le scan :

- **`design-system-font-size` (83) = dette assumée, déjà écrite.** `DESIGN.md:214-216` : « L'échelle ci-dessus décrit les RÔLES, pas l'implémentation. Le code contient vingt-cinq tailles de police distinctes ». Le détecteur mesure exactement ce que le projet a documenté. Faux positifs à en retrancher : `lib/email-auth.ts:265-275` (gabarit d'e-mail transactionnel en chaîne — les clients mail n'appliquent ni Pico ni `globals.css`, une valeur en dur y est la seule option correcte).
- **`design-system-radius` (11) = dette assumée.** `DESIGN.md:292-293` annonce « six valeurs hors échelle (4, 6, 7, 9, 11, 24px) ». Le détecteur retrouve exactement ces six valeurs. Zéro surprise.
- **`design-system-color` (25) : 9 sont des `rgba(0,0,0,α)` d'ombre portée et de voile de modale** — une ombre n'est pas une couleur de palette, faux positif franc. `#25d366`/`#073b26` sont la marque WhatsApp, imposée de l'extérieur et mesurée à 6,37:1. `#ffe8f4`/`#ff9ecb` **sont** dans la palette rose, le détecteur ne les rattache simplement pas. Reste **un vrai défaut** : `admin/demandes/page.tsx:193`, `color: "#166534"` en dur alors que la branche voisine utilise correctement `var(--error-fg)`.
- **`side-tab` (8) : 7 sur 8 encodent de l'information, pas de l'ornement.** `.tri-block li.mine` (:2523) et `.journal li.mine` (:1191) marquent « cette ligne est la mienne » ; `.toast.ok/.err/.info` (:1422, :1426, :1431) portent le seul canal qui distingue les trois types, doublé d'une icône ; `.trn-bkt-match` (:3044) est une case de match dans un arbre de tournoi, où le liseré latéral est la convention du domaine ; `.trn-bkt-title` (:3114) n'est **pas une carte du tout** mais un titre de section — un filet vertical devant un titre est un patron typographique classique, faux positif franc. **Seul `.notice` (:1107) est ornemental** : appliqué à toutes les notices indistinctement, il ne distingue rien. Et c'est précisément la ligne que A attaque par ailleurs.

**Superpositions visuelles : indisponibles.** `tabs_context_mcp` a renvoyé deux fois « Browser extension is not connected ». Aucun onglet n'a pu être énuméré, aucune capture n'existe, **aucun rendu réel n'a été observé** — tout ce rapport vient du calcul sur le code source. Il n'y a donc **aucune superposition visible dans ton navigateur** ; ne la cherche pas. Signal de repli : le scan CLI + les mesures ci-dessous.

## Impression générale

Le vrai sujet de cette critique n'est aucun des défauts pris isolément. C'est un **motif** : **ce projet écrit d'excellentes règles de design, les inscrit dans `DESIGN.md`, les applique à un endroit — et pas au suivant.**

Trois fois le même schéma, découverts indépendamment par les deux relecteurs :

- `DESIGN.md:384-386` interdit de griser par `opacity` un élément qui porte du texte. La règle a été appliquée à `--past` en vue Jour (`globals.css:33-38`, mesuré 4,96:1, conforme à ce que le commentaire annonce). Elle n'a été appliquée **ni** à `.t-end` (`:904-908`, **2,66:1**) **ni** à la vue Semaine (`:2199-2202`, retombée sur `--closed` + `opacity`).
- `globals.css:22-24` documente noir sur blanc l'arbitrage de contraste du vert : « vert « libre » un peu plus profond que le primaire (#1f9d57) pour un contraste AA (5:1) du texte blanc sur les cases ; **le primaire des boutons ne change pas** ». La case a été corrigée. Le bouton est resté à **3,49:1**.
- `HeaderMenu.tsx:70-74` et `LegendInfo.tsx:13-16` énoncent en commentaire « un rôle ARIA qui ment est pire que pas de rôle ». `Dialog` + `useDialog` tiennent le contrat pour 11 modales. **Trois** ne passent pas par là et mentent.

Ce n'est pas un problème de compétence — le niveau des passages réussis est au-dessus de la moyenne du marché. C'est un problème de **propagation**. La plus grande occasion n'est donc pas d'ajouter des règles, c'est de **finir de passer celles qui existent sur toute la surface**, et le gain est disproportionné parce que le travail de conception est déjà fait.

## Ce qui marche

1. **Le bilan de réservation groupée partielle** (`page.tsx:844-870` + `PlanningGrid.tsx:139-145`). Le détail créneau-par-créneau n'est pas jeté dans un toast de 3,5 s : il ouvre un dialogue avec une ligne par échec, et les identifiants ratés repartent dans `failedSel`, qui rouvre le mode sélection avec ces créneaux **déjà cochés**. Un membre qui bloque 5 créneaux pour un tournoi et en obtient 3 sait lesquels ont raté et peut retenter sans rien reconstituer de mémoire. Mieux fait que dans la plupart des produits payants.

2. **Le désamorçage de l'erreur de mode de 21 h** (`page.tsx:56-62`, `78-94`). Ouvrir sur demain après 21 h est la bonne règle ; avoir vu qu'elle **déplace silencieusement le contexte de l'utilisateur** et y répondre par un mot relatif en gras (« Demain · mer. 6 août ») plutôt que par une couleur — parce que le vert est réservé à l'action — c'est un arbitrage de designer, pas un correctif.

3. **La rigueur du mouvement.** B a vérifié les **10 déclarations `animation` sur 10** : toutes couvertes par `prefers-reduced-motion`, y compris l'animation pilotée en JS (`AnnouncementBanner.tsx:204`), où le `!important` du bloc réduit l'emporte sur le style inline. Les 4 transitions non triviales sont traitées finement : la `transition-property` est remplacée pour supprimer le déplacement **en gardant** la couleur. C'est un domaine où presque tout le monde coche la case à moitié ; ici c'est complet.

Mention spéciale : les ratios annoncés dans les commentaires du CSS sont **exacts**. B a recalculé indépendamment `--past-fg` (annoncé 4,96:1 → mesuré 4,96:1), `--warn-fg` sombre (7,95 → 7,95), `--warn-fg` rose (5,73 → 5,73). Quand ce projet écrit un chiffre, on peut s'y fier.

## Problèmes prioritaires

### [P1] Le vert primaire est sous AA partout où il porte du texte

**Quoi.** `--pico-primary: #1f9d57` (`globals.css:10`), identique en clair et en sombre.

| Usage | Paire | Ratio |
|---|---|---|
| Libellé de **tout bouton primaire** | `#ffffff` / `#1f9d57` | **3,49:1** |
| Le même **au survol** | `#ffffff` / `#24b365` | **2,72:1** |
| `--pico-primary` **comme couleur de texte**, 9 sélecteurs | sur carte claire | **3,49:1** |
| idem, thème rose (`#e6007e` sur `#ffe3f2`) | | **3,76:1** |
| **Badges de compteur** blanc sur `--error-accent`, ~10 px | thème sombre | **2,78:1** |
| idem clair / rose | | **3,91:1** |

Les 9 usages en texte incluent le solde personnel `.tri-me.pos` (`:2473`, 18,4 px gras — juste sous le seuil « texte large » de 18,66 px, donc aucune exemption) et le vainqueur `.trn-vs .win` (`:2983`).

**Pourquoi ça compte.** C'est le défaut à la plus grande surface d'exposition du produit : tout bouton primaire, sur les trois thèmes. Et `globals.css:22-24` prouve que l'arbitrage a été **posé puis laissé à moitié** : le vert des cases a été approfondi pour atteindre AA, le primaire des boutons a été explicitement laissé de côté.

**Correctif.** Approfondir `--pico-primary` jusqu'à ≥ 4,5:1 contre le blanc (autour de `#17864a`), ou introduire une paire complète `--primary` / `--primary-fg` par thème comme le projet le fait déjà pour `--past`/`--past-fg` et `--warn-fg`. Les badges de compteur (`:359-371`, `:459-471`) demandent leur propre paire : à 10 px, il n'y a pas d'exemption possible.

**Commande suggérée :** `/impeccable colorize`

---

### [P1] Trois modales revendiquent `aria-modal="true"` sans rien tenir

**Quoi.** Le projet possède `useDialog` (`useDialog.ts:41-67`) qui fournit Échap, piège de focus Tab/Shift+Tab et restitution du focus ; `Dialog.tsx` le câble, et **11 modales l'utilisent correctement**. Trois surfaces sont écrites à la main avec `role="dialog" aria-modal="true"` et **aucun gestionnaire de touche** :

- `AnnounceModal.tsx:35`
- `AnnouncementBanner.tsx:237`
- `WeekGrid.tsx:439` (le fichier n'importe même pas `useDialog`)

A en avait trouvé deux, B les trois — la convergence sur les deux communes, puis l'apport de la troisième, est exactement ce que l'isolement des relecteurs devait produire.

**Pourquoi ça compte.** `aria-modal="true"` **promet** un piège de focus qui n'existe pas : un utilisateur au clavier sort de la modale par Tab et se retrouve à interagir avec une page qu'il croit bloquée. Les deux premières s'ouvrent **automatiquement au chargement** quand le bureau publie une annonce : c'est ce que voit un membre en arrivant, et la seule sortie est un clic. Le dépôt a déjà écrit deux fois, en commentaire, « un rôle ARIA qui ment est pire que pas de rôle ».

**Correctif.** Substituer `<Dialog>` aux trois `<div className="modal-overlay">`. Les trois utilisent déjà les classes `.modal-overlay` / `.modal` : c'est un remplacement de composant, pas un restylage.

**Commande suggérée :** `/impeccable harden`

---

### [P1] 14 champs de formulaire n'ont aucun nom accessible

**Quoi.** WCAG 3.3.2, **niveau A** — le plancher, pas AA. 15 détections, 1 faux positif (`page.tsx:1225`, le sélecteur de date natif `aria-hidden` piloté par un bouton étiqueté, correct), **14 vrais défauts** dont le seul libellé est un `placeholder` — qui disparaît dès la saisie et n'est pas un nom accessible fiable.

`admin/demandes/page.tsx:108, 116` · `admin/page.tsx:504, 565, 574, 604` · **`admin/page.tsx:614`** · `reinitialiser/page.tsx:71` · `SettingsButton.tsx:631, 948` · `Tournament.tsx:916` · `Tricount.tsx:818, 825, 970`

Deux cas sont démonstratifs :

- **`admin/page.tsx:614`** : un `<select>` sans **aucun** nom accessible — ni `<label>`, ni `aria-label`, ni même un placeholder. Annoncé « liste », rien d'autre.
- **`Tricount.tsx:818` et `:825`** : dans **le même formulaire**, les champs voisins sont correctement étiquetés (`<label className="tri-field">Jour du tricount…`, `:807-813` ; `Payé par`, `:832-834`), mais « Libellé » et « Montant » — les deux champs **obligatoires** — ne le sont pas. Ce n'est pas un parti pris, c'est un oubli.

**Pourquoi ça compte.** Encore le motif de propagation : `LoginScreen.tsx` — la seule surface publique — étiquette tout correctement en `htmlFor`/`id`, avec un commentaire à la ligne 311 qui énonce la règle : « Libellés VISIBLES et rattachés. Le placeholder seul ne suffit pas ». La règle est écrite, appliquée sur une surface, absente des 14 autres.

**Correctif.** Rattacher `<label htmlFor>` / `id` sur les 14, en commençant par le `<select>` nu et les deux champs obligatoires du tricount.

**Commande suggérée :** `/impeccable harden`

---

### [P1] La grille elle-même : quadrillage à 1,03:1 et heures de fin à 2,66:1

**Quoi — le quadrillage.** `table.planning th, td { border: 1px solid var(--pico-card-border-color) }` (`globals.css:863-869`). Résolution du jeton vérifiée dans Pico : ligne 321 → `var(--pico-muted-border-color)` en clair, mais **lignes 448 et 583 → `var(--pico-card-background-color)` en sombre**. En thème sombre, la bordure vaut donc exactement la couleur de la carte.

| État | Clair | Sombre |
|---|---|---|
| `--free` | 4,14:1 ✓ | 3,35:1 ✓ |
| `--group` (asso / mien) | **1,03:1** | **1,18:1** |
| `--booked` | **1,05:1** | **1,14:1** |
| `--closed` | **1,04:1** | **1,07:1** |
| colonne Heure | **1,21:1** | — |

**Quoi — les heures de fin.** `.t-end { opacity: 0.65 }` (`globals.css:904-908`) sur un texte déjà `--pico-muted-color`, à 0,66 rem (≈ 10,6 px) : **2,66:1** en clair, 3,10:1 en sombre, 3,00:1 en rose. Sans l'opacité, le clair serait à 5,35:1.

**Pourquoi ça compte.** `DESIGN.md:297-299` déclare cette bordure **structurelle** : « la grille est le seul endroit où la bordure devient structurelle : chaque cellule en porte une, et c'est elle qui dessine le quadrillage ». Elle ne le dessine pas. Trois créneaux consécutifs réservés fusionnent en un seul rectangle sans séparation de ligne. Et l'heure de fin est le « jusqu'à quand » de **chaque ligne**, pour un public que `PRODUCT.md:136` décrit comme « d'âges variés », souvent en extérieur. Les deux défauts sont sur la surface qui **est** le produit.

**Correctif.** (a) Sortir la grille de `--pico-card-border-color` et lui donner son propre jeton par thème, calibré ≥ 3:1 contre les remplissages d'état, consommé à `globals.css:865`. (b) Supprimer `opacity: 0.65` à `:907` et traiter `.t-end` comme `--past-fg` : une paire par thème à ≥ 4,5:1.

**Commande suggérée :** `/impeccable colorize`

---

### [P2] Une panne de chargement laisse le produit vide, sans reprise, avec un code HTTP

**Quoi.** Sur `catch`, `load` fait `setError(message)` puis `setPlanning(null)` (`page.tsx:409-412`). Le rendu retombe alors sur `view === "day" ? planning ? … : loading ? <Skeleton/> : null` → **`null`** (`page.tsx:1344-1373`). Il reste un encart d'erreur puis **rien** là où devrait être la grille, suivi de l'état vide du journal. Le message est la chaîne amont brute ou `Erreur ${pr.status}` (`page.tsx:404`) — donc « Erreur 500 ».

**Pourquoi ça compte.** `PRODUCT.md:129-130` : « Une panne amont se présente en français clair, jamais en message technique. » Le membre voit un code HTTP et un vide, sans astreinte ni support pour l'aider. La seule reprise est l'icône ⟳ sans libellé, deux rangées plus haut, entre deux autres icônes sans libellé.

**Correctif.** (a) Mapper les statuts non-2xx sur des phrases fixes en français à `page.tsx:404` au lieu de propager `pdata.error`. (b) Rendre un bloc d'état vide **à la place de la grille** quand `error` est posé, portant un bouton « Réessayer » câblé sur `reload(true)` — `Placeholders.tsx:20-27` existe déjà, il lui manque une variante avec action.

**Commande suggérée :** `/impeccable clarify`

---

### Second rang

| | Quoi | Où | Preuve |
|---|---|---|---|
| **[P2]** | La vue Semaine ne parle **que** par la couleur, et deux de ses états sont indiscernables | `WeekGrid.tsx:371-395`, `globals.css:2199-2205` | Segments `<span>` **vides** ; `.past` (`--closed` + `opacity: .5`) vs `.closed` (`--closed`) = **1,01:1** l'un de l'autre. WCAG 1.4.1 sur la vue la plus dense |
| **[P3]** | `className="notice warn"` est **inerte** : l'écran « appli bloquée » se peint comme une info | `page.tsx:987`, `globals.css:1107` | Vérifié : `--warn-fg` défini 4 fois, **aucun sélecteur `.warn`** dans `globals.css`. Le bloc se rend en `.notice` nu, liseré **bleu**. Convergence avec le seul `side-tab` réellement ornemental |
| **[P3]** | Vert en dur illisible en thème sombre | `admin/demandes/page.tsx:193` | `#166534` sur `#191e26` = **2,35:1**, alors que la branche voisine utilise `var(--error-fg)` |
| **[P3]** | Le dégradé de carte fait passer le texte discret sous AA | `globals.css:83-85` | Haut de carte sombre composite `#2b3037` : discret **4,35:1**, placeholder **4,20:1**. Les commentaires ne raisonnent que sur le fond plat |
| **[P3]** | Pastille de thème rose sous AA | `globals.css:1688-1689` | `#e6007e` sur `#ffe8f4` = **3,88:1** |

## Signaux d'alarme par persona

**Sam — lecteur d'écran + clavier seul.**
- **Aucun sélecteur de date accessible.** Le `<input type="date">` est `tabIndex={-1}` + `aria-hidden="true"` (`page.tsx:1225-1233`) et `pointer-events: none`. Le bouton appelle `showPicker()`, dont le repli en `catch` est `el.focus()` (`page.tsx:237-245`) — un focus posé sur un élément `aria-hidden` de 1 × 1 px à opacité 0. Là où `showPicker` n'est pas supporté, il ne reste que ← / → **une journée à la fois** : 21 pressions pour un créneau à trois semaines.
- **Le bouton liste d'attente est hors du modèle de navigation de la grille.** `.wait-btn` est un `<button>` **dans** le `<th>` (`PlanningGrid.tsx:274-285`), mais `moveFocus` ne parcourt que les enfants directs de la ligne à `tabIndex === 0` (`:47-52`). Les flèches ne l'atteignent jamais.
- Les trois modales sans Échap, plus `.t-end` à 2,66:1 et le quadrillage à 1,03:1 — Sam est aussi le persona basse vision.
- **Crédit réel** : deux régions `aria-live` **séparées**, l'une pour le chargement, l'autre pour l'action (`page.tsx:1320-1330`), avec le raisonnement écrit — sans ça « Réservation en cours » se met en file derrière « Chargement du planning ». Toasts scindés `alert` assertif / `status` poli. Mieux que la majorité des produits.

**Jordan — première fois, perdu.**
- **Première action évidente en 5 s : non.** Les cases vertes sont la réponse, mais **rien à l'écran ne dit qu'on les touche**. La case dit « Libre » (`PlanningGrid.tsx:413`) — un état, pas une action ; le verbe est enfermé dans `title="Cliquer pour réserver"` (`:410`), que le tactile ne déclenche jamais.
- **La légende explique 3 états sur 8** (`LegendInfo.tsx:46-48`) — il manque « le mien ★ », « passé », « fermé », « en attente », « sélectionné » — et elle est derrière une icône ⓘ sans libellé, coincée entre deux autres icônes sans libellé.
- « 🕒 2 », « ★ », « 👥 » n'existent que dans des `title`.
- **Ce qui marche pour lui** : la confirmation épelle terrain + heure + date longue en français, et « Tu joues déjà sur Squash 1 à cet horaire — un seul terrain à la fois » (`page.tsx:591`) est exactement la bonne phrase au bon moment.

**Casey — mobile, une main, distraite.**
- **Tous les contrôles de mode sont en haut** : les 17 contrôles vivent dans les quatre premières rangées, la zone la plus difficile à atteindre d'un pouce. Le seul contrôle ancré en bas de tout le produit est la barre d'action de la réservation groupée — le parcours le plus rare.
- **Cibles tactiles : 21 règles interactives sous 44 px**, de 26,0 px (`.trn-guest-add button`) à 42,4 px (`.theme-chip`), dont `.wait-btn` 32 × 28 et les segments de la vue Semaine ≈ 43-44 × 42 px. **Nuance importante que B apporte** : toutes passent **AA 2.5.8 (24 px)** ; aucune ne passe **AAA 2.5.5 (44 px)**. Et le seuil retenu par le projet est explicitement 24, documenté en commentaire (`globals.css:934-939` : « on reste compact (la densité est assumée) mais au-dessus du plancher »). Ce n'est donc pas une non-conformité, c'est un arbitrage de densité — à réexaminer pour les plus petits (26-28 px), pas à traiter comme un défaut de masse.
- **La sélection multiple ne survit pas.** Elle vit dans le `useState` local de la grille (`PlanningGrid.tsx:131`) et se vide à tout changement de vue ou de date (`page.tsx:497-499`) : un panier de 6 créneaux disparaît sans avertissement.
- **Crédit réel** : `useBottomBar` masque la bannière d'installation PWA quand la barre « Réserver » est là. Le commentaire décrit le bug d'origine — sur Android, un tap dans la zone recouverte installait la PWA **au lieu** de réserver.

## Observations mineures

- **La fin du parcours principal est un creux.** Après le succès, `reload(true)` n'est pas attendu et `pendingIds` est vidé dans le `finally` (`page.tsx:627-635`) : pendant tout le refetch, **la case qu'on vient de réserver est de nouveau verte et cliquable**, sous un toast qui dit « Réservation confirmée ». Deux messages contradictoires à l'instant exact où l'utilisateur attend la preuve. Règle du pic-fin : la fin est une grille périmée.
- **La confirmation ne nomme jamais ResaMania** (`page.tsx:594-598`). La réservation part sous le compte personnel du membre chez un tiers ; seul le cas délégué nomme un compte. La question la plus anxiogène du parcours — *est-ce que ça me réserve vraiment au club ?* — reste sans réponse à l'instant de l'engagement.
- **Les taps avalés** : `if (busy || confirmState) return;` (`page.tsx:579`, `638`, `670`, `771`). Pendant une action, taper une *autre* case ne produit rigoureusement rien — ni son, ni pixel. Le commentaire de `pendingIds` diagnostique parfaitement ce problème pour la case engagée et ne le traite pas pour les autres.
- **Divergence entre les deux grilles** : le hint du mode sélection a été réécrit dans la vue Jour (`PlanningGrid.tsx:222-227`) et la vue Semaine affiche encore *exactement* la chaîne que ce commentaire dit avoir remplacée (`WeekGrid.tsx:288-290`).
- `AttendeeList` tronque à **4 lettres sans ellipse** dès 3 présents (`PlanningGrid.tsx:81-84`) : « Thom Nico Nata ». `DESIGN.md:380-381` : « une abréviation non étiquetée n'est pas de la densité, c'est une devinette. »
- Les cartes de `/admin` sont des `CSSProperties` inline à `borderRadius: 10` sans ombre (`admin/page.tsx:40-45`), contre 12 px + `--elev-1` + `--card-grad` dans l'app. Deux langages de carte pour un public que `PRODUCT.md:16-19` désigne comme « à part entière ».
- **La pastille « Auj. » désactivée** : `opacity: 0.45` sur un `.secondary` → **2,07:1**. Les contrôles désactivés sont exemptés de WCAG 1.4.3, mais `DESIGN.md:316` promet que « l'état désactivé est **visible** » — à 2,07:1 il ne reste qu'un galet gris. Même patron sur `.coming-soon:disabled`, `.header-menu-item:disabled`, `.refresh:disabled`.
- `range` persiste entre sessions (`page.tsx:485`) alors que `date` et `view` ne le sont délibérément pas : on peut rouvrir demain sur une grille silencieusement filtrée « Soir ».
- **Charge cognitive : 3 échecs sur 8 → modérée**, en haut de bande, à un item du seuil critique. Les trois : focalisation unique, hiérarchie visuelle (tous les contrôles au-dessus de la grille partagent la même recette — 0,8-0,85 rem, texte discret, fond carte, bordure 1 px — et le relief est explicitement non sémantique, donc la hiérarchie ne repose que sur la position), et choix minimaux. Quatre points de décision dépassent 4 options visibles : la barre de vue (5, dont **3 icônes sans libellé mitoyennes**), le menu ⋯ (5-6), le chrome au-dessus de la grille pris comme un tout (17), le panneau Paramètres (7 sections en un seul défilement).
- **Deux replis morts hors thème** : `var(--pico-primary, #0a6)` (`globals.css:1371`) et `var(--pico-muted-color, #8a8a8a)` (`:1743`). Ils ne s'activent jamais, mais seraient à 3,03:1 et 3,45:1 s'ils s'activaient.
- `PlanningGrid.tsx` implémente une navigation aux flèches **sans** revendiquer `role="grid"` : le contrat clavier dépasse la promesse ARIA au lieu de mentir. C'est le cas inverse du problème des trois modales, et c'est la bonne façon de se tromper.

## Questions à considérer

1. **Le club a exactement deux terrains.** Pourquoi la vue Jour est-elle un tableau à *n* colonnes alors que la vue Semaine a déjà inventé la composition à deux terrains ? À quoi ressemblerait la vue Jour si elle cessait d'être un tableau et devenait **deux couloirs de terrain** ?
2. `PRODUCT.md:34-36` définit la réussite comme « la réponse en un coup d'œil ». **Nulle part cette réponse n'est écrite.** Que se passerait-il si la première ligne sous la date disait « 3 créneaux libres ce soir » et si la grille devenait la *justification* de cette phrase plutôt que la réponse elle-même ?
3. **Le parcours rare est mieux conçu que le parcours courant.** Le groupé obtient une barre de progression, un dialogue persistant par créneau et une reprise pré-cochée. L'unitaire — 95 % de l'usage — obtient un toast de 3,5 s et une grille qui n'a pas encore bougé. Que donnerait le patron du groupé appliqué à l'unitaire ?
4. La case libre affiche « Libre » — un état — pendant que le verbe se cache dans un `title`. **Est-ce un état qui se trouve être tappable, ou un bouton qui se trouve décrire un état ?** C'est la décision la plus consultée du produit.
5. **Dix-sept contrôles séparent l'ouverture de l'appli du premier créneau.** Lesquels manqueraient vraiment s'ils passaient dans le menu ⋯ — et la réponse est-elle la même pour l'habitué pressé et pour le nouveau membre non technophile que `PRODUCT.md:124-126` demande de servir sur *une seule* surface ?
6. Le motif de propagation est-il un accident, ou le signe qu'il manque une étape de « passe complète » après chaque règle ajoutée à `DESIGN.md` ?
