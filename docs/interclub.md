# 🏆 Interclub — rencontres par équipes et marquage en direct

Statut : **implémenté** sur la branche `feature/interclub`, sous le flag
`NEXT_PUBLIC_FEATURE_INTERCLUB` — **ON en Recette, OFF en prod**. Tant que le flag est à `0`,
l'onglet n'existe pas et **toutes** les routes `/api/interclub/**` répondent `404`.
Le flux de promotion est celui de [`flux-branches.md`](./flux-branches.md) : on active le flag,
on ne fusionne pas pour livrer.

---

## Le besoin

Le club engage deux équipes en championnat. Une rencontre, c'est quatre simples un jeudi soir,
au meilleur des cinq jeux. Jusqu'ici le score vivait sur une feuille de papier, et le reste du
club apprenait le résultat le lendemain — ou pas.

Trois choses à couvrir, dans cet ordre d'importance :

1. **Marquer** au bord du terrain, sur un téléphone qu'on montre aux joueurs entre deux points ;
2. **Suivre** depuis chez soi, sans rafraîchir la page ;
3. **Consigner** les rencontres passées, y compris celles que personne n'a marquées en direct.

---

## Autorisations — un seul rôle, et c'est une décision

**Tout membre connecté peut créer une rencontre, composer une équipe, prendre le marquage d'un
match et y saisir les points.** Il n'y a pas de rôle « capitaine ».

Ce n'est pas un oubli. Le club compte quelques dizaines de personnes qui se connaissent ;
exiger un rôle bloquerait la saisie exactement les soirs où le capitaine joue — c'est-à-dire
au seul moment où elle sert. Le coût d'une erreur est faible et réversible (tout se corrige) ;
le coût d'un blocage un jeudi soir à 21 h ne l'est pas.

Les seules restrictions protègent quelqu'un d'un **écrasement**, jamais d'un accès :

| Restriction | Où | Ce qu'elle empêche |
|---|---|---|
| Un match **entamé** ne se modifie que par le créateur de la rencontre, le joueur concerné, le marqueur ou un admin | `PATCH …/matches/{mid}` | Écraser silencieusement le travail d'un autre |
| Un match **tenu** par un marqueur non périmé ne s'écrit pas par-dessus lui | `POST …/claim`, `PUT …/live`, `PATCH …/matches/{mid}` | Deux scores divergents qu'on ne saurait départager |
| Un match **terminé** ne se réécrit pas par un TIERS via le direct — le marqueur en titre, lui, le peut (il doit pouvoir annuler le point décisif) | `PUT …/live` | Qu'un passant inverse un score final |
| **Supprimer** une rencontre : créateur et admins | `DELETE …/{id}` | L'irréversible |
| `knownGameCount` : l'écriture doit se fonder sur le même ÉTAT que la base — même nombre de jeux **et mêmes scores** | `PATCH …/matches/{mid}`, `PUT …/live` (règle unique, `staleGamesReason`) | Un écran ouvert dix minutes plus tôt qui efface ce qui a été joué, ou qui rejoue un score corrigé depuis |
| Un simple **« à désigner »** ne peut ni commencer le marquage en direct ni recevoir un score saisi a posteriori | `POST …/claim`, `PUT …/live`, `PATCH …/matches/{mid}` (règle unique, `lineupComplete`) | Une notification qui annoncerait le placeholder comme un vrai nom de joueur |
| Une composition qui romprait l'**ordre des simples par classement** (le mieux classé des joueurs présents doit jouer le simple n° 1) est refusée | `POST /api/interclub`, `PATCH …/matches/{mid}` (règle unique, `lineupOrderConflict`) | Une rencontre disputée dans le mauvais ordre, sanctionnable par la fédération |

Deux choses échappent toutefois au membre, et sont réservées à l'**admin** :

- **l'appartenance à une équipe** (`POST /api/admin/members`, action `set_team`) — elle décide
  qui peut être aligné, donc s'y inscrire soi-même reviendrait à s'inviter dans une
  composition. La route `PATCH /api/profile` l'a acceptée un temps : c'était une erreur
  d'analogie avec le pseudo, qui n'engage que celui qui le choisit ;
- **le roster des joueurs sans compte** (`/api/admin/interclub-teams`), pour la même raison.

Le contrôle d'accès vit dans **`src/lib/interclub-access.ts`**
(`requireInterclubMember`) — un seul endroit, pour qu'une route future ne puisse pas oublier
le flag. ⚠️ À ne pas confondre avec `interclub-gate.ts`, qui ne parle pas de droits du tout :
c'est le cache du direct.

---

## Modèle de données

Six tables (migrations `34_interclub`, `36_interclub_guests`, `37_interclub_notified`,
`38_interclub_order`), plus `AppNotification` (`35_notifications`), qui sert à toute l'appli et
pas seulement ici. La migration `38_` ajoute aussi `User.interclubCltOverride` — la correction
admin d'un classement squashnet mal rapproché (cf. « Ordre des simples par classement »
ci-dessous).

| Table | Rôle |
|---|---|
| `InterclubTeam` | Les équipes de l'asso. Une **table**, pas des colonnes `equipe1/equipe2` : une 3ᵉ équipe ne coûtera qu'une ligne. Semées idempotemment par la migration. |
| `InterclubGuest` | Joueur du championnat **sans compte** sur l'appli. `name`, unique dans son équipe, et `clt` — son classement fédéral, saisi À LA MAIN par l'admin puisqu'il n'y a rien à rapprocher sur squashnet. |
| `Interclub` | La rencontre. `opponent` est un **texte libre** — on ne tient pas d'annuaire des clubs adverses. `startNotifiedAt` / `doneNotifiedAt` sont des **marqueurs d'annonce**, pas des dates d'affichage : rien ne les lit hors des gardes de notification. |
| `InterclubMatch` | Un simple. Porte `homeUserId` **ou** `homeGuestId` (contrainte `CHECK`, jamais les deux), la prise de marquage, et l'instantané du direct (`liveJson`). |
| `InterclubGame` | Un jeu **terminé**. `@@unique([matchId, number])`. |
| `InterclubFollow` | Abonnement d'un membre au suivi d'une équipe. Index `(teamId, level)` : le chemin critique est la requête inverse, « qui prévenir pour l'équipe 2 ? ». |

### Trois décisions à connaître avant de toucher au schéma

**Il n'y a volontairement pas de table « point ».** Environ 200 échanges par match, 800 par
soirée : autant d'écritures sur un chemin chaud, ce que le palier gratuit ne supporte pas. Le
journal des points vit dans le `localStorage` du marqueur ; la base ne reçoit qu'un instantané
throttlé (`InterclubMatch.liveJson`, une écriture toutes les 5 s au plus) et les jeux terminés.
Conséquence assumée : **le déroulé point par point d'un match n'est pas récupérable** depuis un
autre appareil — seuls les scores de jeux le sont (`seedEvents` reconstitue un déroulé
plausible, pas le vrai).

**Le nom du joueur est figé dans `homeDisplayName`.** Supprimer un compte ou retirer un invité
du roster n'efface pas qui a joué. D'où `ON DELETE SET NULL` sur `homeUserId`/`homeGuestId`, et
non `Cascade`.

**Le statut de la rencontre est stocké *et* déduit.** La colonne `Interclub.status` existe,
mais le direct affiche `derivedStatus(matchs)` : deux marqueurs qui écrivent en même temps
peuvent laisser la colonne en retard, et le direct doit être juste tout de suite. La colonne se
recale d'elle-même à chaque écriture.

---

## Les deux modes de saisie

Ils coexistent, et valident tous les deux par le **même moteur pur** (`src/lib/interclub.ts`,
aucune dépendance à Prisma) : ce que l'écran refuse, le serveur le refuse aussi.

**En direct** — `InterclubScorer` → `PUT …/matches/{mid}/live`. Local-first : chaque point est
écrit dans `localStorage` immédiatement, l'écran ne bloque jamais sur le réseau. La synchro part
au plus toutes les 5 s — **sans exception**, undo compris — et porte **l'état dérivé complet**,
jamais un delta : les écritures sont donc idempotentes, ce qui dispense d'une file d'attente
ordonnée à la reprise après coupure. Le seul envoi hors de cette file est celui du score final,
au « Terminer », et le journal local n'est purgé **qu'après** un envoi confirmé.

**Qui engage ?** Le marquage s'ouvre sur cette question — quel joueur, et de quel carré. Le
premier service se tire au sort sur le terrain : ni l'appli ni le serveur ne peuvent le
connaître, et le supposer se trompe une fois sur deux. Les deux cases de points restent
**inertes** tant qu'on n'a pas répondu, parce que le moteur ignore un point sans serveur — des
cases actives absorberaient les appuis en silence, sur un écran qu'on utilise sans le regarder.
Aux jeux suivants, seul le **carré** est redemandé : le règlement désigne le serveur (le
vainqueur du jeu précédent) mais lui laisse le côté. Un match repris dont des jeux sont déjà
enregistrés ne repose pas la question — leur serveur n'a plus d'importance, et le déroulé que
`seedEvents` reconstitue est assumé comme inventé.

**Ce que l'écran de marquage doit rendre lisible.** Il se lit à bout de bras : l'arbitre tourne
le téléphone vers les joueurs. Le score est donc dimensionné pour REMPLIR sa case (requête de
conteneur, repli en `vmin`) et non pour suivre l'échelle typographique — mesuré de **76 px**
(téléphone couché, panneau d'engagement ouvert, le pire cas) à **232 px**. Le reste tient aux
quatre coins pour ne pas lui voler de hauteur.

Les deux cases sont peintes à la **couleur du maillot**, choisie librement : leur encre est donc
calculée, jamais stockée (`inkFor`, blanc ou noir selon le plus lisible). Le pire fond possible
pour une encre binaire est celui où les deux se valent — luminance relative 0,179 — et il tient
encore **4,62:1**. C'est un plancher, pas une moyenne : aucune couleur de maillot ne peut passer
sous AA. ⚠️ **À condition de ne rien composer par-dessus** : une `opacity: 0.9` posée sur les
jeux gagnés composait l'encre avec le maillot et ramenait ce plancher sous le seuil (mesuré
4,49:1 sur `#2e7d32`, 4,22:1 sur `#d81b60`, identique dans les trois thèmes puisque le maillot
n'en dépend d'aucun). C'est le « Don't » d'`opacity` de `DESIGN.md`, appliqué ici.

**A posteriori** — `MatchEditor` → `PATCH …/matches/{mid}`. Jeu par jeu, pour les soirs où
personne n'a marqué, et pour corriger. `games` remplace **intégralement** la liste (une double
soumission ne crée pas deux fois le même jeu), d'où la garde `knownGameCount`.

⚠️ Les **notifications**, elles, ne sont pas idempotentes d'elles-mêmes. Celles qui portent sur
un match (jeu terminé, match gagné) sont gardées sur des **transitions** comparées à ce qui a été
lu en début de transaction : sans cela, un renvoi du même corps — précisément ce que fait la
reprise après coupure — annoncerait une seconde fois la victoire à tous les abonnés.

Les deux qui portent sur la **rencontre** (« la rencontre commence », le résultat final) ne
pouvaient pas s'en contenter, et sont gardées par des **marqueurs persistants**
(`Interclub.startNotifiedAt` / `doneNotifiedAt`, migration `37_`). Le statut d'une rencontre
redescend en effet légitimement : vider les jeux d'un simple pour ressaisir le bon score — le
geste normal avec ce formulaire, qui n'offre qu'un « ✕ » par ligne — la ramène de `done` à
`live`. Comparé au statut stocké, cela ressemblait trait pour trait à un début de rencontre, puis
à une fin toute neuve au second enregistrement : corriger un score annonçait « la rencontre
commence » sur une rencontre jouée deux heures plus tôt, puis renvoyait le résultat à tout le
monde. Un marqueur ne se réarme pas.

### La prise de marquage

Un seul marqueur à la fois (`scorerId` + `scorerClaimedAt`). La prise **se périme au bout de
30 min** (`SCORER_STALE_MS`) : sans cela, un téléphone à plat gèlerait le match pour la soirée.
Toute écriture rafraîchit la prise, et elle **reste** au marqueur après la victoire — il doit
pouvoir annuler le point décisif.

Prendre le marquage ne déclare **pas** la rencontre commencée : c'est le premier point qui la
fait basculer en direct. Écrire `status: "live"` à la prise avait deux effets fâcheux — la
notification de début n'était plus jamais émise (la transition n'existait plus), et un membre
qui touchait « Marquer » par erreur laissait la rencontre « En cours » à vie.

⚠️ Et « le premier point » se prend au pied de la lettre : un instantané à **0-0 sans aucun jeu**
ne fait pas basculer le simple. C'est la désignation du serveur, envoyée pendant l'échauffement,
et le serveur l'acceptait jadis comme un début — ce qui ramenait les deux effets ci-dessus par la
porte de derrière, en consommant DÉFINITIVEMENT `startNotifiedAt` (le vrai début ne notifiait donc
plus jamais). Le score de l'instantané est stocké dans les deux cas : le serveur désigné ne se
perd pas, seul le statut attend le premier point.

---

## Ordre des simples par classement

Règle de la compétition FFSquash, pas une préférence de l'appli : **le mieux classé des joueurs
présents joue le simple n° 1**, et les suivants s'enchaînent en ordre décroissant de classement.
Concrètement, si Albert (classé `5A`) joue le simple 1, Benoît (classé `4D` — mieux classé que
`5A` malgré la lettre, le CHIFFRE domine toujours) ne peut jouer **aucun** simple de cette
rencontre : l'aligner casserait l'ordre quel que soit le numéro qu'on lui donnerait. Deux joueurs
de même classement sont interchangeables — `RangM` n'intervient jamais ici, contrairement au tri
de l'annuaire (`directorySort.ts`), qui compare des **rangs**, pas des **classements**.

**`src/lib/interclub-order.ts`** (module pur, sans Prisma) porte :
- `classementPower(clt)` — le poids d'un classement, plus petit = plus fort. **Liste FERMÉE**
  (2026-09-01, vérifiée contre le règlement sportif FFSquash en vigueur — « Principes du
  classement 2025-2026 », art. 3) : `1I` > `1N` > `2A`…`2D` > `3A`…`3D` > `4A`…`4D` > `5A`…`5D` >
  `NC`. Rien d'autre n'existe côté fédération — en particulier ni `N`, `R1`, `R2` isolés (une
  confusion possible avec `Interclub.division`, texte libre pour la DIVISION d'interclub, sans
  rapport avec le classement d'un joueur), ni série au-delà de 5, ni la 1ère série déclinée en
  lettres (elle ne l'est PAS, contrairement aux séries 2 à 5 — seul un format fermé le rend explicite) ;
- `KNOWN_CLASSEMENTS` — la même liste, énumérée plutôt que devinée depuis une regex, pour peupler
  un `<select>` admin plutôt qu'un champ texte libre (`/admin/membres`, espace admin « Équipes
  interclub ») : un texte libre laissait inventer un classement qui n'existe pas et ne le disait
  qu'à l'écriture ; le sélecteur l'EMPÊCHE dès la saisie. Ordonnée du plus FAIBLE au plus fort
  (`NC` en tête, `1I` en dernier) — l'INVERSE de `classementPower` : dans un club de loisir, les
  corrections courantes portent sur des classements bas, pas sur un `1I` ;
- `lineupOrderConflict(slots)` — le premier problème d'ORDRE entre des simples DÉJÀ DÉSIGNÉS, ou
  `null`. **Moins de deux simples désignés ⇒ rien à comparer**, donc rien à vérifier : c'est une
  règle d'ordre RELATIF, elle n'a par construction rien à dire sur un simple isolé.

⚠️ **Ce n'est PAS la même chose que « avoir le droit de jouer ».** Un joueur dont le classement
est **inconnu** (`clt === null` — jamais rapproché sur squashnet, et aucune correction admin
posée) ne peut disputer **aucun** simple, y compris le tout premier composé d'une rencontre, où
`lineupOrderConflict` seule ne réclamerait rien faute de second joueur à comparer. Cette
exigence-là vit dans `interclub-roster.ts` (`decideMember`/`decideGuest`, appelées par
`resolveHomePick`/`resolveHomePicks`) : composer QUELQUE joueur que ce soit passe TOUJOURS par
elles, avant même que `findOrderConflict`/`lineupOrderConflict` n'aient leur mot à dire — donc
avant que le nombre de simples déjà désignés entre en jeu. Un classement **connu mais faible**
(`NC`) reste, lui, un classement valide : seul `clt === null` (rien à comparer, pas même « le
dernier ») bloque la désignation.

**D'où vient le classement d'un joueur** (`interclub-roster.ts`, `RosterEntry.clt` /
`ResolvedPick.clt`) :
- un **membre** : la correction admin (`User.interclubCltOverride`) si posée, sinon le dernier
  rapprochement squashnet (`SquashnetRanking.clt`) ;
- un **invité** (`InterclubGuest`, sans compte) : son champ `clt`, saisi à la main par l'admin —
  il n'a rien à rapprocher.

**La correction admin existe pour un cas réel** : un rapprochement squashnet qui échoue ou se
trompe (nom mal orthographié côté ResaMania — ex. « Matthieu Soismier » quand squashnet connaît
« Matthieu Soisier »). Deux écrans :
- `/admin/membres`, action `set_clt_override` (`POST /api/admin/members`) — un `<select>` par
  membre, à côté du switch d'équipe interclub ;
- l'espace admin, section « Équipes interclub », actions `add_guest`/`set_guest_clt`
  (`POST /api/admin/interclub-teams`) — le classement d'un invité se saisit au même endroit que
  son inscription au roster.

Les deux valident le format en écrivant (`parseClassementInput`, même module) : une faute de
frappe se signale à la SAISIE, pas le soir d'une rencontre au moment de composer. Et comme la
liste FFSquash est fermée, ils ne proposent que `KNOWN_CLASSEMENTS` — un classement inventé n'est
plus saisissable du tout, au lieu d'être refusé après coup.

**L'EFFECTIF d'une équipe se lit en entier dans l'espace admin** (section « Équipes interclub »).
Cet écran ne montrait qu'un DÉCOMPTE de membres (« 7 membres inscrits ») et la liste des seuls
invités : savoir qui composait réellement une équipe, et à quel classement, obligeait à ouvrir
`/admin/membres` à côté et à reconstituer l'équipe de tête. `GET /api/admin/interclub-teams`
renvoie donc aussi les membres nominativement (`allTeamMembers`, `interclub-roster.ts` — mêmes
règles que `teamRoster` : comptes désactivés exclus, classement effectif via `memberClt`), et
l'écran affiche membres ET invités dans UNE liste triée par `compareRosterOrder`, du mieux au
moins bien classé — c'est-à-dire dans l'ordre où ils devront disputer les simples. Le
RATTACHEMENT, lui, reste sur `/admin/membres` : ici on lit les membres (badge de classement, ou
« classement inconnu » qui dit tout de suite qu'ils ne pourront disputer aucun simple), on
n'édite que les invités.

**La correction admin d'un membre est aussi visible dans l'annuaire** (`GET /api/directory`) :
`clt` y suit la même priorité qu'en composition (override d'abord, rapprochement squashnet
sinon) — sans quoi un membre jamais rapproché (pas encore licencié, nom mal orthographié…)
resterait sans badge de classement dans l'annuaire même après correction admin, alors qu'il en a
un désormais pour l'interclub. `rang`/`rangM`/`cat`, eux, ne viennent QUE du rapprochement
squashnet : une correction manuelle ne porte qu'un classement, jamais de rang.

**Vérifié à l'écriture, jamais figé.** Contrairement à `homeDisplayName`, le classement n'est PAS
stocké sur `InterclubMatch` : `findOrderConflict` (`interclub-roster.ts`) le relit à chaque
composition, contre les AUTRES simples de la rencontre. Un classement qui change ensuite (le
rafraîchissement mensuel squashnet) ne revalide donc pas rétroactivement une composition déjà
enregistrée — exactement le même parti pris que le reste du module (cf. « Le nom du joueur est
figé » plus haut, pour la raison symétrique).

---

## Le direct, et ce qu'il coûte

`PRODUCT.md` proscrit le polling agressif. Le dispositif tient en trois pièces :

- **`src/lib/interclub-gate.ts`** : la réponse du direct vit dans le **Data Cache** de Vercel,
  invalidé par tag à chaque écriture du marqueur (TTL de secours : 30 s). La requête lourde est
  donc bornée par la **cadence du marqueur**, pas par le nombre de spectateurs. Charge utile
  bornée à 6 rencontres et 2 jours en arrière.
- **`InterclubLive`** : **aucun intervalle** les jours sans rencontre — le cas le plus fréquent
  et, jusqu'ici, le plus coûteux. Sinon 10 s tant que l'onglet est visible, et **60 s** tant que
  rien n'est réellement en cours.
- **`onForeground`** : un seul rappel au retour au premier plan, là où `focus` +
  `visibilitychange` en produisaient deux (donc quatre requêtes, cet écran rechargeant la liste
  et le détail).

⚠️ **Ce que le cache n'épargne pas** : `getSession` lit la table `Session` à chaque appel, sans
cache. Dire que « dix spectateurs coûtent une lecture Postgres » serait faux — ils en coûtent
dix légères au lieu de dix lourdes, et le compute Neon reste éveillé de toute façon puisque le
marqueur écrit.

**Ce que le panneau montre — deux états, pas un.** Il s'intitule « En direct » mais liste les
rencontres du JOUR, commencées ou non : c'est la raison d'être de la cadence de veille, qui
existe précisément pour voir la sienne démarrer. Une rencontre prévue ce soir et une rencontre
commencée où personne n'a encore marqué s'affichaient donc à l'identique, score 0–0 compris.
La carte en cours porte désormais le voile `--live-wash` et la pastille `.ic-status` du reste
du module — le vocabulaire d'état existait déjà (`.ic-row-live`, `.ic-match-live`), on ne l'avait
pas appliqué ici.

⚠️ **Pourquoi pas le cache CDN**, contrairement à ce que prévoyait l'étude initiale : un cache
partagé indexe sur l'URL, pas sur le cookie. La première réponse servie à un membre connecté
aurait été rendue à n'importe quelle requête, y compris non authentifiée — les noms des joueurs
seraient devenus publics. `Vary: Cookie` ferait une entrée par session, donc supprimerait tout
le bénéfice.

---

## Notifications

**Le vrai sujet est le dosage, pas la technique.** Une notification par échange, c'est ~800 par
soirée : personne ne garde ça activé plus d'une semaine, et une fonction qu'on désactive ne
resservira jamais. D'où trois paliers :

| Niveau | Ce qu'on reçoit |
|---|---|
| `result` | Le résultat final de la rencontre, avec le détail par joueur — une notification par soirée |
| `highlights` | + le début de rencontre et chaque match gagné |
| `detailed` | + chaque jeu terminé |

**Aucun niveau par défaut** : l'absence de ligne `InterclubFollow` est l'état initial. C'est un
opt-in franc, et l'écran doit le dire — d'où le `null` (« on ne sait pas encore ») distinct de
`[]` (« aucun abonnement ») dans `InterclubFollow.tsx`. Les confondre affichait « Détaillé » à
un compte que la base ne connaissait pas : **abonnement fantôme**, et aucune notification.

Un `tag` par rencontre (`interclub-<id>`) pour ne jamais empiler plus d'une ligne sur l'écran
verrouillé, avec `renotify` pour rester audible — sans quoi la spec impose un remplacement
silencieux et seul le premier événement de la soirée alerterait.

**Le journal (la cloche) est le repli du push**, pas son doublon : il est alimenté depuis le
**transport** (`push.ts`), donc pour tous les destinataires visés, qu'ils aient un abonnement
push ou non. Permission refusée, iPhone hors écran d'accueil, appareil éteint : la notification
reste consultable dans l'appli. Rétention 30 jours, purge opportuniste sur les seuls membres
qu'on vient d'écrire (la clause porte alors sur l'index `(userId, createdAt)`).

---

## Concurrence

Trois routes écrivent en parallèle un soir de rencontre. Toutes passent par
**`serializableTransaction`** (`src/lib/http-tx.ts`) : isolation Serializable + réessai sur
`P2034`, quatre tentatives, et **10 s accordées pour obtenir une connexion** (`maxWait`) — le
défaut de 2 s ne laissait pas à une base froide le temps de se réveiller.

Ce n'est pas facultatif. En Serializable, Postgres ne fait pas patienter les transactions
concurrentes : il en laisse une aboutir et **annule** l'autre. Sans réessai, deux marqueurs qui
touchent la même rencontre se renvoient une erreur alors que rien n'est en faute.

⚠️ Le corps de la transaction est **rejoué tel quel** : aucun effet de bord hors base ne doit
s'y trouver. Les notifications sont donc calculées **dans** la transaction (c'est sa valeur de
retour) et envoyées **après** le commit, hors de la boucle de réessai.

⚠️ **C'est le niveau d'isolation qui rend la garde de notification atomique, pas le marqueur.**
`Interclub.startNotifiedAt` ne fait que constater : lu en début de transaction, posé à la fin. Si
deux marqueurs entament leur simple en même temps, rien n'empêche par lui-même les deux de lire
`null` et d'annoncer. Mesuré (`http-tx.pg.test.ts`, cas C) : en Serializable + réessai, **une
seule** des deux transactions annonce, et les deux écritures aboutissent. La contre-épreuve C2
rejoue la même course en `ReadCommitted` et obtient **deux annonces** — la double notification à
tout le club, reproductible à volonté. Baisser l'isolation d'une de ces routes casserait donc une
promesse qui n'est écrite nulle part dans leur code.

⚠️ Un `Serializable` ne protège **pas** de tout : deux écritures qui ne sont pas concurrentes,
dont la seconde est simplement calculée sur un état périmé, passent sans conflit. C'est le cas
que `knownGameCount` couvre, et lui seul — sur les **deux** routes d'écriture, `PATCH` comme
`PUT …/live`. Sur le direct, le compte annoncé est celui que le serveur a **confirmé** au
marqueur, et non celui qu'il envoie : un undo reste donc légal, seul un journal bâti sur un état
que la base a dépassé est refusé (code `stale-games`, sur lequel l'écran de marquage repart du
score enregistré).

---

## Carte du code

**Moteur pur** (aucune dépendance à Prisma, testable seul)
- `src/lib/interclub.ts` — règles du jeu, replay d'événements, couleurs de maillot, paliers
  d'abonnement. Un jeu se gagne à 11 points avec 2 d'écart ; **2 min entre les jeux** (règles
  WSF du 1ᵉʳ septembre 2025, qui alignent l'amateur sur la PSA). Porte aussi `lineupComplete` —
  les deux joueurs d'un simple sont-ils désignés ? — partagée par le client et les trois routes
  d'écriture (claim, live, PATCH).
- `src/lib/interclub-order.ts` — l'**ordre des simples par classement** : `classementPower`,
  `lineupOrderConflict`, `parseClassementInput`. Cf. « Ordre des simples par classement »
  ci-dessus.

**Côté base**
- `src/lib/interclub-db.ts` — sérialisation, score de rencontre, statut déduit, péremption de la
  prise, et `staleGamesReason` : la **garde de fraîcheur des jeux, écrite une seule fois** et
  appliquée par les deux routes d'écriture. Elle a vécu en double, et les deux copies avaient
  divergé — le `PATCH` n'appliquait qu'une moitié de ce que ce document décrivait. Deux
  exemplaires d'une règle finissent toujours par ne plus dire la même chose.
- `src/lib/interclub-roster.ts` — **qui peut être aligné** (`teamRoster`, `resolveHomePick`, `findAlignmentClash`), l'effectif de TOUTES les équipes pour l'écran d'admin (`allTeamMembers`) et, depuis l'ordre par classement, `findOrderConflict`
- `src/lib/interclub-gate.ts` — le **cache** du direct
- `src/lib/interclub-access.ts` — le **contrôle d'accès** (flag + session)
- `src/lib/interclub-notify.ts` — ciblage des abonnés et rédaction des notifications
- `src/lib/http-tx.ts` — transaction Serializable partagée (sert aussi au tournoi et au tricount)

**Routes**
| Route | Ce qu'elle fait |
|---|---|
| `GET/POST /api/interclub` | Liste des rencontres · création (+ les N simples d'un coup) |
| `GET/DELETE /api/interclub/{id}` | Détail (avec le roster de l'équipe) · suppression |
| `PATCH /api/interclub/{id}/matches/{mid}` | Composition, couleurs, jeux (saisie a posteriori) |
| `PUT …/matches/{mid}/live` | Instantané du marquage en direct — **chemin chaud** |
| `POST/DELETE …/matches/{mid}/claim` | Prendre / relâcher le marquage |
| `GET /api/interclub/live` | État des rencontres du jour (servi par le Data Cache) |
| `GET/PUT /api/interclub/follows` | Mes abonnements |
| `GET/POST /api/admin/interclub-teams` | Équipes, membres et joueurs sans compte, dont leur classement (**admin**) |
| `POST /api/admin/members` (action `set_clt_override`) | Correction admin du classement d'un membre (**admin**) |
| `GET /api/notifications` | La cloche (pas de flag : elle sert à toute l'appli) |

**Composants** — `Interclub.tsx` (orchestration), `InterclubScorer.tsx` (marquage),
`InterclubLive.tsx` (bandeau direct), `InterclubFollow.tsx` (abonnement).

**Tests de composant** — `vitest.config.ts` définit DEUX projets : `node` pour les tests de
modules (la grande majorité, aucun DOM à toucher) et `dom` pour les fichiers `*.dom.test.tsx`,
sous jsdom. Les faire tourner tous sous jsdom coûterait un document complet par fichier pour
rien ; `vitest run --project node` rend la boucle rapide.

Ces tests-là mesurent des **requêtes** et des **corps JSON**, pas des pixels : c'est l'unité dans
laquelle les promesses de cette page sont écrites. Ils couvrent la borne des 5 s du marqueur,
l'absence d'intervalle les jours sans rencontre, la file d'envoi du marqueur, le doute sur
l'accusé de réception, la question « qui engage ? », et l'abonnement qui survit à un échec de
permission. Chacun a été vérifié en réintroduisant le défaut qu'il interdit — un test qui passe
aussi bien avec que sans le correctif ne mesure rien.

**Un troisième genre, à part** — `src/lib/http-tx.pg.test.ts` ouvre deux transactions
CONCURRENTES sur un vrai Postgres. Il se **saute** sans `TEST_DATABASE_URL` (`npm test` reste
rapide et hors-ligne) et refuse de tourner ailleurs que sur `localhost`, puisqu'il écrit. Il
existe parce qu'un faux client ne peut pas répondre à une question de concurrence : il rend le
code d'erreur qu'on lui a soufflé. C'est lui qui a tranché les deux soupçons ci-dessous.

---

## Ce qui reste ouvert

- **Jamais éprouvé sur une vraie soirée** — la mécanique de concurrence est testée en unitaire,
  pas avec quatre téléphones sur quatre courts.
- ~~**Note de confidentialité (RGPD)**~~ — **fait.** `PrivacyNotice` porte deux paragraphes
  conditionnés par le flag `interclub` : ce qui est enregistré et qui le voit ; puis ce qui
  **reste après**. Trois points méritaient d'être écrits noir sur blanc :
  - des **noms de non-membres** figurent en base (les adversaires, saisis à la main ; les
    joueurs de l'équipe sans compte, inscrits par un admin) — donnée nominative saisie par
    quelqu'un d'autre que la personne concernée ;
  - le nom du joueur **survit à la suppression de son compte** (`homeDisplayName` figé,
    `ON DELETE SET NULL`). C'est la seule exception à la promesse « tes données disparaissent
    avec ton compte » faite plus haut dans la même note, et une exception tue rendrait cette
    promesse fausse ;
  - le **déroulé point par point ne quitte pas le navigateur du marqueur** — une donnée qu'on
    ne garde pas mérite d'être annoncée autant qu'une donnée qu'on garde.

  La phrase « c'est le seul endroit où l'appli garde une donnée sur quelqu'un qui n'est pas
  membre » se **nuance** désormais quand l'interclub ou le tournoi sont actifs : sans cela, la
  note se contredisait d'un paragraphe à l'autre. `PrivacyNotice.dom.test.tsx` tient le
  couplage dans les deux sens — le paragraphe doit apparaître avec le flag, et disparaître
  sans lui : une note qui décrit un traitement inexistant est fausse elle aussi.
- **Les deux soupçons sur `http-tx.ts` ont été tranchés** sur un vrai Postgres
  (`src/lib/http-tx.pg.test.ts`, six mesures — `npm run test:pg`, cf. l'en-tête du fichier pour
  le conteneur jetable). Le premier tombe, le second se précise :

  - **Ne rejouer que `P2034` est correct.** On craignait que « supprimer puis réinsérer les
    jeux » sorte en `P2002` (violation d'unicité, non rejouée ⇒ 500). Mesuré sur deux
    transactions concurrentes : le second marqueur sort en **`P2034`**, que la table soit vide
    ou déjà peuplée — sous Serializable, Postgres voit le conflit avant d'arriver à l'index
    unique. Passée par `serializableTransaction`, la course **aboutit des deux côtés**, au
    second tour. Rien à corriger.
  - **Les deux bornes par défaut existent, et produisent un `P2028` non rejoué**, donc un 500 :
    `timeout` à 5 s, `maxWait` mesuré à 2005 ms. Deux précisions ont décidé de la suite. D'abord,
    `timeout` **n'interrompt rien** : la requête va au bout de son travail, c'est au retour
    qu'elle est refusée — le relever ne protégerait pas la base, cela déplacerait le moment où
    l'on jette un travail abouti. Il **reste donc au défaut**. Ensuite, le plafond qui compte est
    `maxWait`, qui court **avant le premier ordre SQL**, sur l'obtention de la connexion : c'est
    là que tombe un réveil de base froide, donc la première écriture d'une soirée. Il est
    **relevé à 10 s** (`MAX_WAIT_MS`), et le cas B4 vérifie qu'une attente de plus de 2 s aboutit
    désormais au lieu de sortir en 500. Ce qu'aucun Postgres local ne peut dire, et qui reste à
    observer sur Recette un jour de base froide : combien de temps Neon met réellement à se
    réveiller.
- **`Interclub.tsx` fait ~980 lignes** et concentre quatre écrans. Découpage à envisager si un
  cinquième s'ajoute.
- **Pas de vue « saison »** : ni classement, ni historique par équipe. Volontaire pour un
  premier jet — la liste des rencontres suffit tant qu'on en compte une dizaine par an.
