# squashnet.fr — carte des points d'entrée

Ce que l'appli sait déjà lire sur le site fédéral, ce qu'elle pourrait lire, et à quel prix.
Tout ce qui suit est **public et sans authentification** : aucun cookie, aucun compte, aucun
jeton — un `POST` en `application/x-www-form-urlencoded` et un fragment de HTML rendu serveur
en retour.

> **Cadre.** Comme pour ResaMania (cf. README), c'est de la rétro-ingénierie d'un site tiers
> qui ne nous a rien promis. Le rendu peut changer sans préavis — il l'a déjà fait, le
> 2026-08-26, en basculant tout son HTML des guillemets simples aux doubles. C'est pourquoi
> chaque parsing vit isolé, testé sur fixture réelle, et pourquoi les appels sont espacés.

---

## Le point d'entrée unique

**Toutes** les sections passent par la même URL. Seul `ic_a` dit laquelle.

```
POST https://www.squashnet.fr/index.php
content-type: application/x-www-form-urlencoded; charset=UTF-8
x-requested-with: XMLHttpRequest

ic_a=<section>&mustache=1&ic_ajax=1&<paramètres de la section>
```

`src/lib/squashnet/client.ts` porte cet appel (`postAjax`) : en-têtes, délai de garde et URL.
Toute nouvelle section doit passer par lui — deux copies du même appel dérivent, et c'est
l'en-tête de l'une des deux qu'on oubliera de corriger.

## La carte des sections

Les identifiants ci-dessous **ne sont pas devinés** : ils sont lus dans les fragments déjà
captés (`src/lib/squashnet/__fixtures__/`), où chaque lien de navigation porte son action en
clair (`<a id="players" data-ic_a="393475" …>`).

| `ic_a`   | Section                     | Paramètres                        | État                        |
|----------|-----------------------------|-----------------------------------|-----------------------------|
| `131079` | Classement des joueurs      | `name`, `month`, `gender`, `ligue`… | ✅ lu (`client.ts`)         |
| `393986` | Calendrier d'une épreuve    | `eventid`, `roundid`              | ✅ lu (`calendar.ts`)       |
| `394242` | Classement d'une poule      | `eventid`, `drawid`, `roundid`    | ✅ lu (`standings.ts`)      |
| `393480` | **Fiche d'une équipe**      | `teamid`                          | ⬜ non lu — voir « roster » |
| `393475` | **Joueurs d'une épreuve**   | `eventid`                         | ⬜ non lu                   |
| `394243` | **Résultats d'une épreuve** | `eventid` (+ `drawid`/`roundid` ?) | ⬜ non lu — voir « résultats » |
| `393479` | Équipes d'une épreuve       | `eventid`                         | ⬜ non lu                   |
| `393217` | Informations d'une épreuve  | `eventid`                         | ⬜ non lu                   |
| `393729` | Impression (PDF)            | `eventid`, `drawid`               | — sans intérêt ici          |

### Les quatre identifiants, et pourquoi ils ne se valent pas

C'est le piège principal de ce site, et il a déjà coûté deux pannes **muettes** :

| Identifiant | Désigne              | Exemple                          |
|-------------|----------------------|----------------------------------|
| `eventid`   | L'ÉPREUVE            | « Critérium IDF Équipes Hommes » |
| `drawid`    | La DIVISION          | `47760` = Hommes 4               |
| `roundid`   | La POULE             | `370138` = poule IVD             |
| `teamid`    | L'ÉQUIPE             | `161089`                         |

- **Sans `roundid`**, le calendrier rend *une* poule au hasard — bien formée, où notre équipe
  ne figure pas. Zéro rencontre importée, aucune erreur.
- **Sans `drawid`**, le `roundid` du classement est **ignoré** et la fédération rend la
  division 1 : un tableau parfaitement crédible, et faux.
- **`teamid` ne filtre rien** sur le calendrier : on reçoit la poule entière (quinze
  rencontres pour cinq des nôtres), à charge pour nous de retenir les bonnes.

La règle qui en découle, tenue par les routes d'admin : **les quatre ensemble, ou aucun.**

---

## Ce que ça débloquerait (demandes en attente)

### 1. Roster de l'équipe adverse — `ic_a=393480`

**Faisabilité : bonne.** Le lien existe et son action est connue : sur la fiche d'une équipe
(le nom de club cliquable dans le calendrier comme dans le classement de poule), squashnet
appelle `393480` avec le seul `teamid`. Or **on a déjà ce `teamid`** : `parseTeamCalendar` le
lit sur les deux équipes de chaque rencontre, et il est même stocké pour la nôtre
(`InterclubTeam.snTeamId`).

Il manque **une seule chose** : une capture du fragment rendu par `393480`, pour écrire le
parsing. Elle se fait en trente secondes depuis un navigateur (onglet Réseau → la requête
`index.php` → « Copier la réponse »), et se range en fixture à côté des deux autres.

Le classement de chaque joueur adverse, lui, **ne demande aucun nouvel endpoint** :
`searchRanking(nom)` + `matchRanking(..., { club: "<club adverse>" })` — la fonction accepte
déjà un club cible autre que l'Yvette, c'est prévu dans sa signature.

### 2. « Contre qui on a joué » — `ic_a=394243`

Moitié déjà là : l'appli **enregistre** l'adversaire de chaque simple qu'elle a servi à
marquer (`InterclubMatch.awayName`, `homeDisplayName`, jeu par jeu). Ce qui manque, ce sont
les rencontres jouées **hors de l'appli**, et la version officielle des scores.

C'est la section « Résultats » (`394243`). Même besoin qu'au-dessus : une capture, puis un
parsing. Le rapprochement avec nos rencontres existe déjà (`snMatchKey = <eventid>:<round>`).

### 3. Historique des classements ✅ fait

Voir `SquashnetRankingPoint`, `lib/squashnet/history.ts`, `lib/squashnet/backfill.ts` et
l'écran « Progression ». Aucun nouvel endpoint : le `<select id="month">` du classement expose
les **publications passées**, et `131079` les sert toutes. D'où le remplissage **rétroactif**,
au lieu d'attendre deux ans que la courbe se dessine.

**Deux portes pour le même remplissage**, parce qu'un chargement complet (≈ 960 couples
joueur × mois) dure un quart d'heure quand une fonction Vercel est tuée à soixante secondes :

| Porte | Usage | Comment |
|---|---|---|
| `npm run rankings:backfill` | **Premier chargement** (24 mois d'un coup) | Sans couperet, 1,1 s entre deux appels, ~15 min |
| `/admin` › « Compléter l'historique » | **Entretien** (un nouvel inscrit, un mois qui manque) | Tranches de ~45 s, 600 ms entre deux appels, on reclique jusqu'à « complet » |
| cron `warm-rankings` (le 8) | **Automatique** | Consigne le point du mois courant à chaque rapprochement réussi |

Le découpage en tranches n'est sûr que parce que le remplissage est **reprenable** : les
couples déjà en base sont sautés sans un seul appel réseau (`knownPoints`). Sur un historique à
jour, recliquer ne coûte **aucune requête**.

⚠️ « Sans réponse » n'est pas du travail restant : un joueur n'aura jamais de mesure sur les mois
où il n'était pas licencié. Seul `remaining` (les couples pas encore *regardés*) tombe à zéro —
c'est lui que le bouton affiche.

#### L'historique suit le JOUEUR, pas le membre du club

Le rapprochement normal exige **nom + club** (`YVETTE_CLUB`) : c'est ce qui permet au passage
mensuel de constater qu'un membre a quitté le club (verdict `moved`) et de retirer son
classement. Appliqué tel quel au remplissage rétroactif, ce filtre confondait deux situations
opposées — « il est parti » et « il n'était pas encore là » — et **tronquait la courbe à la date
d'arrivée au club**.

Le remplissage passe donc `classifyRanking(..., { horsClub: true, licence })`, avec deux niveaux :

1. **La licence d'abord**, quand on la connaît (`SquashnetRanking.licence` pour un membre,
   `InterclubGuest.snLicence` pour un invité — renseignées par le rapprochement déjà réussi au
   club). C'est un identifiant fédéral : insensible au club, à l'orthographe et aux homonymes.
   Une licence connue mais **absente** de la réponse ne conclut rien — elle peut manquer parce
   que le joueur n'était pas licencié ce mois-là, mais aussi parce que la colonne est vide sur
   cette ligne — et on retombe sur le nom.
2. **À défaut, le nom, tous clubs confondus.** L'unique ligne au nom du joueur est acceptée.
   **Plusieurs lignes restent `unknown`** : deux personnes du même nom un même mois sont deux
   personnes, et rien ne dit laquelle. C'est le seul cas que la licence tranche pour de bon.

⚠️ **Ce mode ne rend JAMAIS `moved`**, et c'est tout son intérêt : il n'y a plus de « dehors »
dont on pourrait constater l'absence. Il ne doit donc **pas** servir au passage mensuel, qui a
besoin de ce verdict — et dont le disjoncteur de volume en dépend. Le mensuel ne passe d'ailleurs
ni `horsClub` ni `licence`.

Conséquence assumée : un membre qui quitte le club voit sa courbe **continuer** avec les
classements publiés sous son nouveau club. C'est cohérent avec « la progression du joueur », et
c'est ce que l'écran annonce.

#### La mémoire des trous — et l'aveu qui va avec

`SquashnetRankingProbe` consigne ce qu'on a **cherché en vain**, là où `SquashnetRankingPoint`
dit ce qu'on sait. Sans elle, les recherches vaines — l'essentiel du travail sur les vieux mois —
étaient repayées à chaque clic, le budget de 45 s s'épuisait toujours au même endroit, et
« reste » ne tombait jamais à zéro.

⚠️ **Cette table et ses fonctions ont vécu un temps sans que rien ne les appelle.** La migration,
`writeProbe` et `knownCouples` avaient été écrites et commitées, mais `backfill.ts` utilisait
toujours `knownPoints` : le code était mort, la table vide dans les deux bases, et le défaut
qu'elle devait fermer intact. Branché le 2026-09-09, en même temps que le mode hors club.

Ce qu'elle marque, et ce qu'elle ne marque pas :

| Situation | Marque | Pourquoi |
|---|---|---|
| squashnet a répondu, le joueur n'y est pas (`unknown`) | ✅ | Un classement publié ne change plus : l'absence est définitive |
| squashnet a répondu, le joueur est ailleurs (`moved`) | ✅ | Idem — et en mode hors club ce verdict ne sort plus |
| squashnet n'a **pas** répondu (réseau, 5xx, délai) | ❌ | C'est un incident, pas un verdict : le mois reste ouvert |
| Échec d'écriture de la marque elle-même | ❌ | La marque est un confort, pas une donnée — le lot continue |

`backfillHistory({ retryProbes: true })` ignore les marques : c'est la reprise à demander **après
avoir corrigé le nom de recherche d'un membre**, seul cas où une absence peut se dénouer.

#### Son propre flag : `NEXT_PUBLIC_FEATURE_RANKING_HISTORY`

L'écran « Progression » **n'est pas adossé à `ranking`**, et c'est délibéré. `ranking` est le
seul flag ouvert en production (cf. `docs/flux-branches.md`) : la courbe y serait apparue devant
les membres le jour de son merge, sans que personne l'ait décidé.

Elle ne montre d'ailleurs pas la même chose que le badge « 5A ». Celui-ci dit **où un joueur en
est** ; celle-là rend lisible, à tout membre connecté, **le chemin parcouru par chacun sur trois
ans**, et invite à comparer les courbes côte à côte. C'est une finalité de plus, elle a son
paragraphe dans `PrivacyNotice`, donc elle a son interrupteur.

| Environnement | Valeur | Effet |
|---|---|---|
| Production | **absente** (fail-safe) | Entrée « Progression » grisée, `GET /api/rankings/history` en 404 |
| Preview (Recette) | `1` | Écran ouvert |

**Les deux flags sont exigés, « et » jamais « ou »** — à l'écran (`page.tsx`), à la route, et
dans la note de confidentialité. `rankingHistory` seul sur un `ranking` coupé afficherait un
historique qui gèle sans le dire, puisque c'est la passe mensuelle qui l'alimente.

⚠️ **La conservation, elle, ne s'arrête pas avec l'écran.** `writePoint` ne consulte pas
`rankingHistory` : flag coupé, les mesures continuent d'être écrites mois après mois. C'est
voulu (le jour où l'on ouvre l'écran, l'historique est déjà là), et c'est pourquoi le paragraphe
« Progression » de la note reste affiché sous `ranking` — il change seulement de phrase pour
dire que rien n'est affiché pour l'instant. Masquer ce paragraphe avec l'écran tairait une
conservation bien réelle.

#### Les lignes de passage d'un classement à l'autre

Derrière les courbes, en pointillés, passent les marches « 5B », « 5A »… (`frontieresClassement`,
`lib/ranking-history.ts`). Sans elles, « 1 180 points » ne veut rien dire ; avec elles, on voit
de quel côté de la marche on se trouve.

**Elles ne viennent d'aucun barème écrit en dur** — ce dépôt ne connaît pas le barème de la
fédération, et l'inventer donnerait un graphique crédible et faux. Elles se déduisent de nos
propres mesures : chaque point porte à la fois le classement publié ce mois-là **et** la moyenne
qui l'a produit. La plus **basse** moyenne jamais vue sous « 5B » et la plus **haute** jamais vue
sous « 5A » encadrent la frontière, qu'on pose au milieu. Plus le corpus grossit, plus
l'encadrement se resserre : la règle graduée s'affine seule.

#### ⚠️ `mean` et `rangM` sont la MÊME grandeur — l'écran ne trace plus que le rang

Mesuré le 2026-09-09 sur les 81 mesures de la recette, et sans ambiguïté possible :

| Signal | Résultat |
|---|---|
| Corrélation `mean` ↔ `rangM` | **r = 1,000** — les deux sont la même grandeur à un lissage près |
| Ordre des 7 classements observés | 4B (le plus fort) 1496–1659 … 5D (le plus faible) 7240–9052 |
| Les 6 changements de classement de l'historique | chaque montée s'accompagne d'un `mean` qui **baisse** |

Ce que squashnet appelle « moyenne » n'est donc pas une moyenne de POINTS qu'on accumulerait,
mais une **moyenne de rang** — d'où la corrélation parfaite, et d'où le fait qu'une moyenne
**plus petite** soit un **meilleur** classement.

Deux conséquences, toutes deux traitées le 2026-09-09 :

1. **La courbe « Points » était dessinée à l'envers.** Le code affirmait
   `plusGrandEstMieux("mean") === true` et le disait jusque dans le libellé sous le sélecteur :
   le joueur qui progressait plongeait, et la colonne « évolution » mettait un moins devant sa
   meilleure saison. C'est aussi ce sens inversé qui empêchait la moindre marche d'apparaître,
   chaque paire de classements échouant en silence à son test d'encadrement.
2. **Le sélecteur de métrique a été retiré.** Proposer « Points » ou « Rang » offrait un choix
   sans conséquence — deux vues du même chiffre — payé par une décision à chaque ouverture.
   L'écran ne trace plus que `rangM`, la valeur que la fédération publie telle quelle. `mean`
   reste stocké : il ne coûte rien, et c'est la version lissée de la même mesure.

⚠️ Le refus initial de tracer des marches sur le rang (« un classement ne correspond à aucun
rang fixe ») reposait sur l'hypothèse que les deux grandeurs étaient indépendantes. Elles ne le
sont pas, et **le rang donne une marche de plus que la moyenne** (5 contre 4 sur le corpus) : le
passage 5B→5A est net en rangs et chevauchant en moyennes.

#### L'échelle s'élargit un peu pour faire entrer une marche proche

L'écran s'ouvre sur **un** joueur (son parti pris), donc sur les quelques dizaines de points
qu'il a parcourus en un an. Aucune frontière n'y tombe tant qu'il n'a pas changé de classement :
sans correctif, la vue par défaut n'aurait jamais montré de ligne.

`bornesAvecMarches` élargit donc l'échelle du seul côté utile, et d'un **quart de l'étendue
déjà affichée** au maximum (`MARGE_MARCHE`). En dessous, la marche reste invisible ; au-delà, on
ferait entrer un repère hors de portée en aplatissant la courbe du joueur. Un joueur au milieu de
sa catégorie ne voit toujours rien — il n'y a rien à lui dire.

Sur le corpus réel de la recette (8 joueurs, 11 mois), cela donne **5 marches** (5B, 5A, 4D, 4C,
4B), dont **5 joueurs sur 8** en voient au moins une seuls à l'écran. Le passage 5D→5C n'est pas
tracé : ses plages se chevauchent d'une publication à l'autre, et c'est exactement le cas où
l'on préfère ne rien dire.

⚠️ **Bornes INCLUSES des deux côtés**, dans le filtre des lignes comme dans `bandesClassement`.
Une comparaison stricte d'un côté seulement les faisait diverger dans le cas le PLUS courant :
`bornesAvecMarches` élargit l'échelle *jusqu'à* la frontière, donc `f.valeur === bornes.min` en
sortie — le trait se dessinait et le fond restait vide. Mesuré : la moitié des joueurs qui
voyaient une ligne n'avaient aucune bande.

#### Les zones sont peintes en UNE teinte dosée, jamais une couleur par échelon

Entre deux marches, le fond dit dans quel classement on se trouve — ce qui répond d'un coup
d'œil à « je suis dans quoi, là ? » sans lire une étiquette.

**Une seule teinte par thème, dosée en opacité** (`--rankhist-bande`, 4 % à 17 %), du plus pâle
en bas au plus soutenu en haut. Les classements forment une **échelle** : une couleur par
échelon — bleu pour 5B, orange pour 5A — obligerait à apprendre une légende au lieu de lire la
pente, et détruirait l'ordre que le graphique existe pour montrer. Le plafond bas est ce qui
garde les douze couleurs de courbes lisibles par-dessus.

La teinte est propre à chaque thème : bleu froid en clair, bleu clairci en sombre (sur fond
sombre il faut **éclaircir**, un bleu profond à 10 % ne se distingue de rien), rose soutenu en
thème rose. Les libellés « 5A », eux, gardent le jeton de TEXTE — c'est la bande qui porte
l'identité, le mot la nomme.

Trois cas où **aucune ligne n'est tracée**, plutôt qu'une ligne mal placée :

- **sur le rang** — un classement ne correspond à aucun rang fixe (le rang dépend du champ), donc
  la « ligne du 5A » se déplacerait tous les mois ;
- **quand deux catégories se chevauchent** — une moyenne vue sous « 5A » sous une moyenne vue sous
  « 5B » : le corpus se contredit (barème révisé, classement corrigé à la main) ;
- **entre deux échelons non adjacents** — « 5C » puis « 5A » sans « 5B » observé : la marche en
  recouvrirait deux, et l'étiqueter « 5A » ferait lire un seuil unique là où il y en a deux.

Le calcul porte sur **tout le corpus reçu**, jamais sur la sélection à l'écran : une frontière est
une propriété de l'échelle fédérale, pas de qui l'on regarde. Cocher un joueur ne doit pas
déplacer les repères sous ses pieds. Seul l'**affichage** est borné à la fenêtre visible — une
ligne hors bornes serait plaquée sur le bord du cadre, où elle se lirait comme une frontière
atteinte.

#### La courbe s'arrête à une date qu'on n'explique pas

Trois causes possibles, et une seule commande pour les départager :

```bash
npm run rankings:mois     # imprime le sélecteur de période de squashnet
```

1. **La fédération ne publie pas plus loin.** Si la liste s'arrête à la même date que la courbe,
   il n'y a rien à récupérer au-delà : `MOIS_PAR_DEFAUT` (24) est une profondeur que la source
   ne peut pas tenir. Ce n'est pas un défaut de l'appli, et le bouton d'admin le dit
   (« complet sur les N périodes que squashnet publie »).
2. **Le remplissage n'a pas fini.** Il balaie du **plus récent au plus ancien** : un run
   interrompu — budget de la tranche épuisé, script coupé — laisse donc manquants exactement
   les mois les **plus vieux**. Reclique « Compléter l'historique » jusqu'à zéro restant.
3. **Le bogue du `distinct` paginé** (corrigé). `findMany({ distinct: ["month"], take: 36 })`
   ne fait pas de `SELECT DISTINCT` : Prisma dédoublonne **en mémoire, après le `take`**. La
   route demandait donc « les 36 dernières **lignes** », soit un seul mois à quarante joueurs —
   le nombre de mois affichés dépendait du nombre de joueurs mesurés. Remplacé par un
   `groupBy(["month"])`, qui se traduit par un vrai `GROUP BY`.

Pour savoir si la base contient plus que ce que l'écran montre :

```sql
SELECT month, count(*) FROM "SquashnetRankingPoint" GROUP BY month ORDER BY month;
```

#### « Tout le monde a une seule mesure, sauf une personne »

C'est le motif le plus fréquent, et il ne vient d'aucun défaut : **une mesure = le mois
courant**, écrit par la passe mensuelle pour tout joueur rapproché. Les joueurs qui n'en ont
qu'une n'ont donc **jamais** été traités par le remplissage rétroactif — typiquement parce que
celui-ci a tourné avant qu'ils ne soient `listed` ou alignés en équipe, donc avant qu'ils
n'entrent dans `subjectsToRefresh`.

Le remplissage ne rattrape jamais tout seul : il balaie les joueurs d'**aujourd'hui**, mais
seulement quand on le lance. Il faut donc le relancer après chaque vague d'inscriptions.

⚠️ **Le relancer par le bouton coûte cher dans ce cas** : ~40 joueurs × ~23 mois manquants ≈
900 couples, soit une douzaine de clics de 45 s. Le script fait la même chose d'une traite :

```bash
npm run rankings:backfill
```

Pour établir le diagnostic avant d'agir :

```bash
npm run rankings:diag          # qui a combien de mesures, et sur quelle plage
npm run rankings:diag -- "Dupont" 2026-01-05    # le verdict live d'un joueur, un mois
```

Le second mode rejoue à l'identique ce que fait le remplissage et imprime le verdict. Il
débusque la panne silencieuse que le schéma documente déjà : quand ResaMania a enregistré
« Nom Prénom », le terme cherché est un **prénom**, la réponse déborde d'homonymes, et le
verdict est « introuvable » tous les mois sans que rien ne le signale. Remède :
`squashnetGivenName` / `squashnetFamilyName` sur le membre.

### 4. Historique des matchs d'un joueur — **endpoint inconnu**

C'est la seule demande qui n'a pas de chemin identifié. Les lignes du classement des joueurs
**ne sont pas cliquables** : pas de lien, pas de `data-ic_a`, donc rien à observer dans les
fragments déjà captés. Il existe peut-être une fiche joueur ailleurs sur le site, mais rien
dans ce qu'on a ne le prouve.

Deux chemins possibles, dans cet ordre :

1. **Le détour par les épreuves** (sûr, borné) : reconstituer l'historique d'un joueur à
   partir des résultats des épreuves qu'on suit déjà (`394243`, ci-dessus). Couverture limitée
   aux championnats par équipes de nos équipes — mais c'est 100 % de ce que jouent la plupart
   des membres.
2. **La fiche joueur** (à explorer) : chercher, depuis un navigateur, si un `ic_a` sert une
   page de joueur à partir de son **numéro de licence** — on l'a déjà en base
   (`SquashnetRanking.licence`). Tant que ce n'est pas observé, ce n'est qu'une hypothèse.

### 5. « Des infos intéressantes sur un joueur »

Sans l'endpoint du point 4, voici ce qui est atteignable **aujourd'hui** pour un joueur donné,
et qui n'est affiché nulle part : sa courbe de moyenne de points et de rang (fait), sa
catégorie d'âge, sa ligue, son club de rattachement, son ancienneté au club (premier mois
mesuré), et — via le point 2 — ses adversaires et son bilan en championnat.

---

## Règles de bonne conduite

- **Espacer les appels.** Le remplissage rétroactif attend 1,1 s entre deux requêtes
  (`backfill.ts`, `DELAI_MS`) : c'est le débit d'un humain qui pagine, donc invisible pour eux.
  C'est la condition pour que tout ceci continue d'exister.
- **Ne jamais confondre « vide » et « illisible ».** Un fragment qui a la *structure* d'un
  calendrier mais dont on ne tire rien signale un rendu qui a changé, pas une poule vide
  (`CalendarUnreadableError`). Sans cette distinction, un changement de HTML annonce aux
  capitaines que tout le calendrier a été « retiré ».
- **N'affirmer un rapprochement que s'il est certain.** Une seule ligne du club qui colle,
  sinon rien (`match.ts`). Un mauvais classement affiché est pire qu'aucun.
- **Recapturer les fixtures quand le rendu change**, plutôt que d'assouplir un parsing jusqu'à
  ce qu'il ne casse plus.
