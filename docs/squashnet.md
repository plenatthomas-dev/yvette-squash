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
| `393480` | Fiche d'une équipe          | `teamid` **seul**                 | ✅ lu (`roster.ts`)         |
| `393475` | Joueurs d'une épreuve       | `eventid`                         | ⬜ coquille vide — voir ci-dessous |
| `394243` | **Résultats d'une épreuve** | `eventid` (+ `drawid`/`roundid` ?) | ⬜ non lu — voir « résultats » |
| `393479` | Équipes d'une épreuve       | `eventid` (+ `teamid`)            | ⬜ non lu — porte le même roster |
| `393477` | **Fiche d'un JOUEUR**       | `regiid`                          | ⬜ non lu — voir point 4     |
| `394248` | **Feuille de match**        | `tieid` **seul**                  | ✅ lu (`tie.ts`)            |
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

### 1. Roster de l'équipe adverse — `ic_a=393480` ✅ fait

Voir `src/lib/squashnet/roster.ts`, `src/lib/interclub-roster-db.ts` et la table
`SquashnetTeamRoster` (migration `52_opponent_roster`).

**AUCUN GESTE À FAIRE.** Le roster se rafraîchit tout seul aux deux moments où il sert : à
l'ouverture d'une rencontre dans Interclub (on va désigner les joueurs d'en face) et au début
d'une vérification capitaine. Le serveur ne sort chez la ligue que si le roster manque ou date
de plus d'une semaine (`ROSTER_FRAIS_JOURS`) — un soir de rencontre, où l'écran s'ouvre vingt
fois, seule la première ouverture coûte une requête.

**UN SEUL PARAMÈTRE : `teamid`.** C'est l'exception au piège des quatre identifiants — ni
`eventid`, ni `drawid`, ni `roundid`. Mesuré, pas supposé : la fixture
`equipe-2026-161095-roster.html` a été captée avec ce seul paramètre.

Ce que la fiche donne, par joueur inscrit : **nom fédéral, genre, licence, classement, rang et
rang mixte**, plus la date d'inscription dans l'équipe. Et, dans son tableau `info`, la
distinction que le dépôt devait jusqu'ici déduire : le nom de l'**ÉQUIPE** (« Verrieres 2 »,
numéro compris) *et* celui du **CLUB** (« Squash club verrieres le buisson »), sous lequel la
fédération range ses joueurs. C'est exactement le piège que `clubOfTeam` a dû contourner — la
ligue publie les deux, il n'y a plus à deviner.

**CE QUE ÇA REMPLACE.** Le classement d'un adversaire s'obtenait par RAPPROCHEMENT :
`searchRanking(nom)` + `matchRanking(..., { club })`, une recherche par joueur, un échec sur un
accent, et un verdict « introuvable » indistinguable d'un silence du site. Une requête par
équipe remplace huit recherches, et il n'y a plus rien à rapprocher.

**LE TABLEAU EST EXIGÉ SOUS SON IDENTIFIANT** — `<table id="players_161095">`. C'est ce qui rend
impossible la panne muette du `drawid` (§ « Les quatre identifiants ») : ou bien on lit les
joueurs de l'équipe demandée, ou bien on lève `RosterUnreadableError`. Un roster VIDE reste
distinct d'un roster illisible — une équipe inscrite sans joueur est un fait de début de saison.

⚠️ **Ce sont les INSCRITS, pas les ALIGNÉS.** Un club inscrit son effectif en septembre ; qui
joue tel soir n'en dépend pas. Un joueur aligné contre nous et absent de la liste existe
(mutation tardive, inscription oubliée) — d'où la saisie libre, conservée dans les menus.

⚠️ **La clé doit d'abord exister en base.** `Interclub.snOpponentTeamId` est posé par l'import du
calendrier ; les rencontres importées avant la migration 52 le portent à NULL, et seul un
**ré-import** (Admin › Interclub › Calendrier › Appliquer) peut le remplir — il est dans le HTML
de la ligue, pas dans nos données. Le cron ne l'écrit pas : il alerte, il n'applique jamais.

### 2. La feuille de match officielle — `ic_a=394248` ✅ fait

Voir `src/lib/squashnet/tie.ts` (parsing), `src/lib/captain-official.ts` (la confrontation, pure)
et `src/lib/interclub-tie-db.ts` (base et réseau). Colonne `Interclub.snTieId`, migration
`53_fixture_tie_id`. Fixture : `rencontre-2026-1643001-feuille.html`.

La feuille donne, simple par simple : les **deux joueurs** avec leur classement **du soir**, le
score **jeu par jeu**, le vainqueur, et les comptes de jeux et de points — puis le **total de la
rencontre**, celui qui fera le classement de fin de saison. L'écran Capitaine le confronte à
notre relevé : « la ligue publie 4-1, ton relevé dit 4-1 », ou la liste des écarts.

**OÙ TROUVER LE `tieid`.** Nulle part dans un calendrier. Ni `393986` (l'épreuve), d'où viennent
pourtant nos rencontres importées, ni ailleurs : **seule la fiche d'équipe (`393480`) le
publie**, sur chaque ligne de son calendrier (`data-tieid`). Lire une feuille commence donc par
lire la fiche de **sa propre** équipe — une requête, cachée une semaine, pour toute la saison.

⚠️ **Une fiche d'équipe porte PLUSIEURS calendriers.** La fixture de référence en a deux :
`round_338671` (« Hommes 4 - Poule A », 18 rencontres) et `round_370137` (« Hommes 4 - Poule
IVC », 6 de plus). S'arrêter au premier tableau perdrait toute la phase finale, en silence.

⚠️ **Le rapprochement se fait sur la DATE.** Mesuré, pas choisi : les deux phases renumérotent
leurs tours depuis 1 (deux « Tour 1 » à huit mois d'écart), les tours ne suivent pas l'ordre des
dates (le 15 se joue avant le 13), et le même adversaire revient à l'aller et au retour. Quand
une date en désigne deux — les journées d'**exemption**, adversaire « Non Joue » —, on ne pose
rien plutôt que de choisir.

⚠️ **« 0 / 0 » N'EST PAS UN SCORE.** La fédération le publie sur toutes les journées à venir,
avec le libellé « Non joué ». Le lire comme un résultat annoncerait un nul sur une rencontre qui
n'a pas eu lieu — et à quatre simples, ce nul est crédible.

⚠️ **« A » et « B » ne sont pas « nous » et « eux ».** Les colonnes de joueurs portent le
**sigle** de chaque équipe dans leur `data-label` : `A:VERR2`, `B:VERR3`. C'est une **donnée**,
pas un vocabulaire — impossible à coder en dur, et rien ne dit que « A » soit le receveur. On
reconnaît notre côté par le sigle (le nôtre, ou celui d'en face), à défaut par nos alignés, et à
défaut **on ne compare rien** : se tromper afficherait un 4-1 *gagné* sur une rencontre perdue.

⚠️ **Ce que la ligue ne publie PAS : « à toi de valider ».** Cet état n'existe nulle part dans le
HTML public (le seul jeton `validate` rencontré est le `novalidate` d'un formulaire). On sait
dire « rien de saisi », « saisi en partie », « saisi et conforme », « saisi et divergent » —
jamais « qui doit valider ».

**La ligne de total se reconnaît à son intitulé VIDE**, pas à sa position : elle a exactement la
forme d'un simple, et la prendre pour tel ajouterait un match fantôme à la feuille.

### 2 bis. « Contre qui on a joué » — `ic_a=394243`

Reste ouvert, et n'est plus urgent : les scores officiels viennent désormais des feuilles de
match (ci-dessus), rencontre par rencontre. `394243` n'apporterait que les rencontres jouées
**hors de l'appli**, en une seule requête au lieu d'une par rencontre. Même besoin qu'avant :
une capture, puis un parsing.

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

### 4. Historique des matchs d'un joueur — **piste ouverte : `ic_a=393477`**

La demande n'avait aucun chemin identifié tant qu'on ne regardait que le classement, dont les
lignes ne sont pas cliquables. La fiche d'équipe en a ouvert un : **chaque nom de joueur y est
un lien** vers `393477`, avec un paramètre qu'on ne connaissait pas — `regiid`, l'identifiant
d'une INSCRIPTION (un joueur dans une épreuve), et non celui d'une personne.

```
<a data-ic_a="393477" data-ic_ajax="1" data-regiid="591184">DETRY XAVIER</a>
```

Ce `regiid` est lisible dans le fragment que `roster.ts` parse déjà — mais il n'est PAS retenu
aujourd'hui, faute de savoir ce que la section rend. Prochaine étape : capter `393477&regiid=…`
et voir si elle porte un historique de rencontres. Tant que ce n'est pas observé, c'est une
hypothèse.

⚠️ Ne pas confondre avec l'appel `393477&eventid=…` : la section « Joueurs d'une épreuve »
(`393475`) rend une **coquille vide**, dont le tableau est rempli par un second appel à `393477`
portant l'`eventid` et un jeton `ic_csrf` lu dans la coquille. Sur l'épreuve d'essai, ce
tableau-là est ressorti **sans aucune ligne** — le roster par équipe est la voie qui marche.

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
