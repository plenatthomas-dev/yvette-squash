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
les **publications passées**, et `131079` les sert toutes. D'où le remplissage **rétroactif**
(`npm run rankings:backfill`), au lieu d'attendre deux ans que la courbe se dessine.

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
