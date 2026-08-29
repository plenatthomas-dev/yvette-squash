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
| `knownGameCount` : l'écriture doit se fonder sur le même nombre de jeux que la base | `PATCH …/matches/{mid}`, `PUT …/live` | Un écran ouvert dix minutes plus tôt qui efface ce qui a été joué |

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

Six tables (migrations `34_interclub`, `36_interclub_guests`, `37_interclub_notified`), plus
`AppNotification` (`35_notifications`), qui sert à toute l'appli et pas seulement ici.

| Table | Rôle |
|---|---|
| `InterclubTeam` | Les équipes de l'asso. Une **table**, pas des colonnes `equipe1/equipe2` : une 3ᵉ équipe ne coûtera qu'une ligne. Semées idempotemment par la migration. |
| `InterclubGuest` | Joueur du championnat **sans compte** sur l'appli. Un seul champ `name`, unique dans son équipe. |
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
`P2034`, quatre tentatives.

Ce n'est pas facultatif. En Serializable, Postgres ne fait pas patienter les transactions
concurrentes : il en laisse une aboutir et **annule** l'autre. Sans réessai, deux marqueurs qui
touchent la même rencontre se renvoient une erreur alors que rien n'est en faute.

⚠️ Le corps de la transaction est **rejoué tel quel** : aucun effet de bord hors base ne doit
s'y trouver. Les notifications sont donc calculées **dans** la transaction (c'est sa valeur de
retour) et envoyées **après** le commit, hors de la boucle de réessai.

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
  WSF du 1ᵉʳ septembre 2025, qui alignent l'amateur sur la PSA).

**Côté base**
- `src/lib/interclub-db.ts` — sérialisation, score de rencontre, statut déduit, péremption de la prise
- `src/lib/interclub-roster.ts` — **qui peut être aligné** (`teamRoster`, `resolveHomePick`, `findAlignmentClash`)
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
| `GET/POST /api/admin/interclub-teams` | Équipes, membres et joueurs sans compte (**admin**) |
| `GET /api/notifications` | La cloche (pas de flag : elle sert à toute l'appli) |

**Composants** — `Interclub.tsx` (orchestration), `InterclubScorer.tsx` (marquage),
`InterclubLive.tsx` (bandeau direct), `InterclubFollow.tsx` (abonnement).

---

## Ce qui reste ouvert

- **Jamais éprouvé sur une vraie soirée** — la mécanique de concurrence est testée en unitaire,
  pas avec quatre téléphones sur quatre courts.
- **Note de confidentialité (RGPD)** : l'interclub crée de la donnée nominative (qui joue,
  contre qui, quel score) et une nouvelle finalité de notification. À documenter dans
  `PrivacyNotice` **avant** d'activer le flag en prod, comme cela a été fait pour l'annuaire.
- **Aucun test de composant** — c'est la convention du dépôt (il n'existe aucun `.test.tsx`),
  mais cela veut dire que le marqueur, l'écran le plus délicat, n'est couvert que par les tests
  du moteur qu'il pilote.
- **`Interclub.tsx` fait ~980 lignes** et concentre quatre écrans. Découpage à envisager si un
  cinquième s'ajoute.
- **Pas de vue « saison »** : ni classement, ni historique par équipe. Volontaire pour un
  premier jet — la liste des rencontres suffit tant qu'on en compte une dizaine par an.
