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

⚠️ « Sans réponse » n'est pas du travail restant : un membre arrivé au club l'an dernier n'aura
jamais de mesure sur les mois d'avant. Seul `remaining` (les couples pas encore *regardés*)
tombe à zéro — c'est lui que le bouton affiche.

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
qui l'a produit. La plus haute moyenne jamais vue sous « 5B » et la plus basse jamais vue sous
« 5A » encadrent la frontière, qu'on pose au milieu. Plus le corpus grossit, plus l'encadrement
se resserre : la règle graduée s'affine seule.

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
