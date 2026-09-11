# `feature_captain` — résumé de la branche

> Écrit pour être lu **après un `git pull`**, sans avoir suivi la conversation.
> Point de départ : `a5225b5`. Cinq commits. 29 fichiers, ~4 500 lignes ajoutées.

---

## 1. Ce que la branche apporte, en une phrase

Un **second rôle** (le capitaine), un **écran qui vérifie une rencontre avant de la saisir chez
la fédération**, et — parce que la vérification apprend le classement des adversaires — un
**menu de choix des joueurs d'en face** qui leur impose le même ordre des simples qu'à nous.

---

## 2. Le problème d'origine

Le score officiel d'une rencontre interclub **ne se publie pas tout seul** : un capitaine le
saisit sur squashnet, le capitaine adverse le valide. Les deux gestes se font des jours après la
rencontre, sur un formulaire qui exige les joueurs **tels que la fédération les orthographie**.

Or l'orthographe est exactement ce qui diverge d'un système à l'autre. Le dépôt le savait déjà :
`User.squashnetGivenName` / `squashnetFamilyName` existent pour réparer ça, et leur commentaire
raconte comment un rapprochement échouait « en silence, mois après mois ».

L'écran de vérification répond donc à une question précise : **quels noms vont coincer** — et on
veut la réponse **avant** d'ouvrir squashnet, pas devant un formulaire qui refuse.

---

## 3. Les cinq commits

| # | Commit | Ce qu'il fait |
|---|---|---|
| 1 | `826623c` | Le rôle capitaine + l'écran de vérification (**lot 1**) |
| 2 | `223ff0d` | L'écran devient la **feuille de match qu'on recopie** : spinner, récap des scores jeu par jeu, contrôle de l'ordre des simples adverses |
| 3 | `9b2cce6` | Ne répète plus le nom d'un joueur deux fois — `plenat Thomas — Squash de l Yvette` / `4D #2318 · 0121214` |
| 4 | `47565b4` | **Bug** : cherche l'adversaire sous son **club**, pas sous le numéro de son équipe |
| 5 | `a651fef` | Les **deux menus** (club adverse, ses joueurs) + l'**ordre des simples adverses à la désignation** |

---

## 4. Le rôle capitaine

`src/lib/captain-access.ts` — un second rôle, **borné à l'officiel**.

- `requireCaptain(req)` / `requireCaptainOf(req, teamId)` — la portée d'un capitaine est **SON
  équipe** : le capitaine de l'Équipe 1 ne peut rien sur une rencontre de l'Équipe 2.
- Ordre des refus, volontaire : **flag → 404**, **session → 401**, **rôle → 403**. Un 403 sur une
  fonctionnalité désactivée révélerait qu'elle existe.
- Un admin passe partout, avec `teamIds` vide.
- La désignation se fait dans l'espace admin, et le serveur **refuse un capitaine qui ne joue pas
  dans l'équipe** — c'est presque toujours une erreur de saisie.

**Ce qui n'a PAS changé** : composer une rencontre, saisir un score, marquer en direct restent
ouverts à **tout membre**. Le capitanat n'est pas une hiérarchie, c'est une responsabilité
fédérale — cf. `docs/interclub.md`, « La seule exception : le capitaine, et seulement pour
l'officiel ».

---

## 5. L'écran de vérification

`src/components/Captain.tsx` · `GET`/`POST /api/captain/check/{id}` · règles pures dans
`src/lib/captain-check.ts`.

Ce qu'il vérifie, en un geste :

1. **Chaque joueur** — les nôtres **et** ceux d'en face — existe-t-il au classement fédéral ?
   Trois verdicts qui n'appellent pas la même réaction :
   - `found` — avec son **nom fédéral, son classement, son rang mixte, sa licence** : c'est ce
     qu'on recopie chez la ligue ;
   - `other-club` — trouvé, mais ailleurs. Ce n'est pas une faute d'orthographe ;
   - `unknown` — soit introuvable, soit **squashnet n'a pas répondu**. Les deux se distinguent :
     annoncer « introuvable » sur un silence enverrait corriger une orthographe juste.
2. **Les scores** — chaque simple a-t-il un vainqueur, au `bestOf` de la rencontre ? Le compte de
   la rencontre est-il complet ? Avec le **détail point par point** de chaque jeu.
3. **L'ordre des simples adverses** — trois états, et le troisième n'est pas une faute :
   `ok` (rien à dire) / `violation` (signalé) / `unverifiable` (un adversaire non rapproché →
   **on ne conclut rien**).

Chaque problème est affiché **avec son remède en toutes lettres**.

### Deux verbes, et la différence est le coût

| Verbe | Ce qu'il fait | Coût |
|---|---|---|
| `GET` | relit le dernier rapport | gratuit, instantané |
| `POST` | **refait** la vérification et la range | jusqu'à 8 recherches fédérales, ~10 s |

Le débit est ménagé : mémoïsation **par nom de famille** (deux homonymes partagent la réponse),
600 ms entre deux appels, période lue **une seule fois** (sinon 16 appels au lieu de 8).
squashnet est un site associatif qui ne nous doit rien.

### Le stockage

`InterclubOfficial` (migration `53_interclub_official`) — **une rencontre, un rapport** :
relancer **corrige** au lieu d'empiler, donc l'écran n'a jamais à choisir entre deux versions.

`checkedAt` n'est pas décoratif : sans lui, « rien à signaler » et « on n'a pas encore regardé »
s'affichent pareil, et c'est la seconde qui coûte cher un dimanche soir.

⚠️ **Aucune colonne d'avance** pour la saisie ni la validation — elles viendront avec le code qui
les écrit. Le dépôt porte déjà une colonne morte (`Interclub.division`) et sait ce qu'elle coûte.

---

## 6. Les deux menus d'en face (commit 5)

### Ce qu'ils résolvent

Le nom d'un adversaire était un **champ de texte**, recopié à la main un soir de rencontre sur un
téléphone. « Détry » un mois, « detry » le suivant : le rapprochement fédéral échouait sur un
accent, et le rapport déclarait « introuvable » un joueur parfaitement réel.

Deux menus (`GET /api/interclub/opponents`) suppriment la ressaisie :
- **le club adverse** à la création d'une rencontre ;
- **ses joueurs** à la composition d'un simple.

### D'où vient ce qu'on sait d'eux

**D'aucune requête fédérale.** Deux sources déjà en base, fusionnées par `mergeOpponents` :

| Source | Ce qu'elle donne |
|---|---|
| `InterclubMatch.awayName` | tous les adversaires jamais alignés contre nous — le nom, rien de plus |
| `InterclubOfficial.checkJson` | pour ceux qu'une vérification a rapprochés : nom fédéral, classement, rang mixte, licence |

Le second **enrichit** le premier. La liste s'enrichit donc d'elle-même, rencontre après
rencontre, sans un appel de plus.

⚠️ **Ce n'est pas le roster de l'équipe adverse** : un joueur croisé pour la première fois n'y
est pas. La **saisie libre reste atteignable** dans les deux menus (« — un autre club/joueur — »).

### Deux règles de fusion qui se voient à l'usage

- pour un **joueur** : le nom **le plus récent** (dernière correction à la main) et l'identité
  fédérale **la plus riche** (une vérification aboutie vaut mieux que trois muettes) ;
- pour une **équipe** : le **premier** — un nom d'équipe est estampillé par l'import du
  calendrier fédéral, jamais corrigé à la main ; une variante ultérieure (« chaville 4 ») le
  **dégrade** au lieu de le corriger.

La fusion replie la **casse, les accents et les espaces** — **pas les fautes de frappe** :
« Detri » reste un autre joueur que « Detry ». C'est le menu qui traite la faute de frappe, en
rendant la ressaisie inutile.

---

## 7. L'ordre des simples, appliqué en face

La règle du classement (le mieux classé dispute le simple n° 1 ; à classement égal le meilleur
rang mixte passe devant) vaut **pour les deux équipes** — une rencontre disputée dans le mauvais
ordre est sanctionnable des deux côtés.

`awayLineupConflict` **délègue à `lineupOrderConflict`**, celle-là même qui refuse notre propre
composition. Deux copies de cette règle finiraient par diverger.

**Le refus tombe dès la DÉSIGNATION**, pas à la vérification la veille de la feuille de match —
la rencontre est alors jouée, et il n'y a plus rien à corriger :

- `POST /api/interclub` (composition entière) ;
- `PATCH /api/interclub/{id}/matches/{mid}` (retouche d'un simple, le geste le plus courant) ;
- et **l'écran grise d'avance** ce que la route refuserait.

### ⚠️ On ne refuse que ce qu'on CONNAÎT

C'est la **différence irréductible avec notre camp**. `lineupOrderConflict` refuse un joueur sans
classement : juste chez nous, où un admin peut le renseigner ; **absurde en face**, où personne
ne le peut. Ce serait rendre impossible d'inscrire une **première rencontre contre un club jamais
croisé** — le cas le plus banal d'un début de saison.

Dès qu'**un seul** adversaire désigné nous est inconnu (ou sans classement, ou non-NC sans rang
mixte), **on ne conclut rien**.

---

## 8. Carte des fichiers

**Nouveaux — moteur pur** (aucun Prisma, testable seul, utilisable **par l'écran**)
- `src/lib/captain-check.ts` — verdicts joueurs, contrôle des scores, ordre adverse, garde de
  forme du rapport stocké (`lireRapport`)
- `src/lib/interclub-opponents.ts` — `mergeOpponents`, `opponentTeams`, `estDesigne`,
  `awayLineupConflict`

**Nouveaux — côté base**
- `src/lib/captain-access.ts` — le contrôle d'accès capitaine
- `src/lib/interclub-opponents-db.ts` — `loadKnownOpponents`, `findAwayOrderConflict`

**Nouvelles routes**
- `GET /api/captain` — les rencontres de mes équipes
- `GET`/`POST /api/captain/check/{id}` — relire / refaire la vérification
- `GET /api/interclub/opponents` — les équipes et joueurs déjà rencontrés

**Nouvel écran**
- `src/components/Captain.tsx` — l'onglet « Capitaine »

**Modifiés**
- `src/app/api/interclub/route.ts`, `.../matches/[mid]/route.ts` — la garde d'ordre adverse
- `src/components/Interclub.tsx` — les deux menus
- `src/app/api/auth/me/route.ts` — expose `captainOf`
- `src/app/page.tsx` — l'entrée de menu, **absente** (pas grisée) si on n'est pas capitaine
- `src/components/PrivacyNotice.tsx` — le rapport stocke le nom fédéral, le classement et la
  licence **d'adversaires** : ça se dit
- `prisma/schema.prisma` + migration `53_interclub_official`
- `docs/interclub.md`, `docs/idees-developpement.md`

**La séparation pur / base** est celle d'`interclub-order.ts` (pur) et `interclub-roster.ts`
(base) : c'est ce qui permet à l'écran de griser **exactement** ce que la route refuserait.

---

## 9. Deux bugs trouvés en écrivant le code, pas signalés par l'usage

**a. Les équipes numérotées** (`47565b4`). Les noms d'équipe fédéraux portent un numéro
(« Chaville 4 », « UCPA Meudon 2 »), mais le classement range les joueurs sous le **club**
(« Chaville »). Résultat : **aucun adversaire d'une équipe numérotée n'était jamais trouvé**, et
le remède affiché envoyait corriger une orthographe parfaitement correcte. Corrigé par
`clubOfTeam`.

**b. Deux écarts dans la fusion** (`a651fef`) :
- l'en-tête promettait de replier les fautes de frappe — c'est faux, et le commentaire le dit
  maintenant ;
- le nom d'**équipe** retenait la dernière orthographe alors que c'est la **première** (celle de
  l'import) qui fait foi.

---

## 10. État des vérifications

Au dernier commit de la branche (`a651fef`) :

```
npx vitest run                        → 2445 passed | 34 skipped
npm run lint                          → propre
npx tsc --noEmit -p tsconfig.check.json → propre
npx next build                        → OK (les 3 routes dans la sortie)
```

---

## 11. ⚠️ À savoir avant de reprendre

### La branche est en retard sur `main`

`main` a avancé de **7 commits** depuis le point de départ (l'historique de classement — lot A —
y a été fusionné puis affiné). Avant toute fusion :

```bash
git checkout feature_captain
git fetch origin
git merge origin/main
```

Rien ne laisse prévoir un conflit dur — les deux travaux touchent des fichiers différents — mais
`docs/idees-developpement.md` et `prisma/schema.prisma` sont modifiés des deux côtés.

### La migration 51 s'est appliquée au build Preview

Elle est **purement additive** (une table vide de plus, aucune colonne touchée sur l'existant).
Si Preview et prod partagent la même base Neon, c'est déjà fait côté prod.

### Les menus peuvent paraître vides — c'est normal

- Le menu **joueur** ne se remplit qu'avec des rencontres **déjà saisies** contre ce club. Sur
  une base sans historique, il reste en champ libre.
- Le **classement** d'un adversaire (`4D #2318`) n'apparaît qu'après une **vérification
  capitaine** sur une rencontre passée. Sans elle, **aucun grisage** — c'est voulu.

---

## 12. Ce qui reste à faire

### Lot 2 — lire l'état fédéral d'une rencontre ✅ **fait**

L'écran Capitaine confronte désormais notre relevé à **la feuille de match que la ligue
publie** : « la ligue publie 4-1, ton relevé dit 4-1 » — ou la liste des écarts, jeu par jeu,
avec le lien vers la feuille.

⚠️ **La promesse d'origine était fausse, et elle est corrigée ici.** Elle disait
« l'adversaire a saisi, **à toi de valider** ». Cet état n'est **pas public** : rien dans ce que
la fédération publie ne dit qu'une feuille attend une validation (le seul jeton `validate`
trouvé sur ces pages est l'attribut `novalidate` d'un formulaire). Ce qu'on sait dire, et qui
suffit à l'usage :

| On sait dire | On ne sait PAS dire |
|---|---|
| la ligue n'a rien saisi | c'est à toi de valider |
| elle a saisi une partie des simples | qui des deux capitaines a saisi |
| elle publie X-Y, et ça concorde | la feuille est-elle définitive |
| elle publie X-Y, et voici les écarts | |

**Ce que ça a demandé, et qui n'était pas prévu.** Le `tieid` — l'identifiant de la feuille —
n'est **dans aucun calendrier**. Ni celui de l'épreuve (`ic_a=393986`), d'où viennent pourtant
toutes nos rencontres importées, ni ailleurs : il n'existe que sur la **fiche d'équipe**
(`ic_a=393480`), ligne par ligne. Lire une feuille commence donc par lire la fiche de sa propre
équipe — une requête, mise en cache une semaine, pour toute la saison.

**Deux pièges mesurés, tous deux silencieux si on les rate :**

1. **le rapprochement se fait sur la DATE**, jamais sur le tour ni sur l'adversaire. Une équipe
   joue **deux phases** (« Poule A » puis « Poule IVC »), chacune renumérotée depuis 1 : il y a
   deux « Tour 1 » à huit mois d'écart. Les tours ne suivent même pas l'ordre des dates (le 15
   se joue avant le 13), et le même adversaire revient à l'aller et au retour. Quand une date en
   désigne deux (les journées d'exemption), **on ne pose rien** ;
2. **« A » et « B » ne sont pas « nous » et « eux »**. La ligue nomme les deux camps sans dire
   lequel reçoit, et les colonnes portent le **sigle** de chaque équipe dans leur `data-label`
   (`A:VERR2`, `B:VERR3`) — une donnée, pas un vocabulaire. Se tromper de côté afficherait un
   4-1 **gagné** sur une rencontre perdue. On reconnaît notre côté par le sigle, à défaut par
   nos alignés, et **à défaut on ne compare rien**.

Code : `squashnet/tie.ts` (parsing) · `captain-official.ts` (confrontation, pur) ·
`interclub-tie-db.ts` (base et réseau) · colonne `Interclub.snTieId` (migration 53).

### Lot 3 — poser les deux gestes (saisir, valider)

Demande :
1. **ton accès capitaine** chez la fédération (tu ne l'as pas encore) ;
2. la **capture d'un parcours connecté** — le formulaire de saisie, celui de validation ;
3. un **`CaptainCredential`** chiffré en base.

Garde-fous déjà arbitrés pour ce lot, à ne pas rediscuter :
dépôt **facultatif** · **jamais** renvoyé au client (l'API ne dit que `hasCredential: true`) ·
lisible **par son seul propriétaire**, pas même par un admin · suppression en **un geste** ·
**auto-révoqué** à la perte du capitanat · un paragraphe dans `PrivacyNotice`.

⚠️ Note technique : `postAjax` (`src/lib/squashnet/client.ts`) **ne gère aucun cookie**. Un
chemin authentifié demande un client distinct, avec un magasin de cookies par requête.

### Le vrai roster adverse ✅ **fait**

`ic_a=393480` (fiche d'équipe fédérale) donne la composition **complète** d'une équipe — licence,
classement, rang mixte —, au lieu de « ceux qu'on a déjà rencontrés ». Le blocage annoncé
(« capture à faire ») n'en était pas un : la section répond au **seul** `teamid`, sans `eventid`,
`drawid` ni `roundid`. C'est l'exception au piège des quatre identifiants.

---

## 13. Comment tester au pouce

Le détail est dans le plan de la session précédente ; l'essentiel :

1. **URL de preview** — Vercel › Deployments › branche `feature_captain` › Visit.
2. **Se reconnecter** — autre domaine, autre session. Normal.
3. **Se nommer capitaine, DANS CET ORDRE** :
   `/admin/membres` → s'affecter une **équipe interclub**, **puis** `/admin` → se désigner
   **capitaine**. L'inverse renvoie une erreur qui a l'air d'un bug et n'en est pas.
4. **Recharger** — `/api/auth/me` est lu au chargement ; l'entrée « Capitaine » apparaît au menu ⋯.
5. **Vérifier une rencontre terminée** — compter ~10 s.

Pour voir le **chemin rouge** (le plus instructif) : donner à un adversaire un nom inexistant, ou
vider les jeux d'un simple, ou mettre à un adversaire le nom d'un joueur de l'Yvette (attendu :
ℹ️ « autre club », pas ⚠️ « introuvable »). **Remettre les vraies valeurs ensuite** — la base
Preview contient de vraies rencontres.
