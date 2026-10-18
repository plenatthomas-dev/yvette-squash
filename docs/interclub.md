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

**Tout membre connecté peut composer une équipe, prendre le marquage d'un match et y saisir
les points.** Créer une rencontre, en revanche, est réservé à l'admin depuis octobre 2026 (voir
plus bas) : le calendrier squashnet synchronisé les génère. Il y a bien un **capitaine** par équipe depuis le calendrier,
mais ce n'est pas un rôle : c'est une **désignation**, et il ne peut rien que les autres ne
puissent (cf. « Calendrier, capitaines et disponibilités »).

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
| `knownGameCount` + `knownGames` : l'écriture doit se fonder sur le même ÉTAT que la base — même nombre de jeux **et mêmes scores**. Ce sont les jeux OUVERTS dans l'écran qu'on compare, jamais ceux qu'on envoie : sans quoi corriger un 11-5 en 11-7 se refuserait lui-même. | `PATCH …/matches/{mid}`, `PUT …/live` (règle unique, `staleGamesReason`) | Un écran ouvert dix minutes plus tôt qui efface ce qui a été joué, ou qui rejoue un score corrigé depuis |
| Un simple **« à désigner »** ne peut ni commencer le marquage en direct ni recevoir un score saisi a posteriori | `POST …/claim`, `PUT …/live`, `PATCH …/matches/{mid}` (règle unique, `lineupComplete`) | Une notification qui annoncerait le placeholder comme un vrai nom de joueur |
| Une composition qui romprait l'**ordre des simples** (le mieux classé des joueurs présents doit jouer le simple n° 1 ; à classement égal, le meilleur rang mixte passe devant) est refusée | `POST /api/interclub`, `PATCH …/matches/{mid}` (règle unique, `lineupOrderConflict`) | Une rencontre disputée dans le mauvais ordre, sanctionnable par la fédération |
| Le même refus s'applique à la composition **adverse** — mais seulement quand tous les adversaires désignés nous sont connus | les deux mêmes routes (`awayLineupConflict`) | La sanction vaut des deux côtés ; refuser sur une base incomplète empêcherait d'inscrire une première rencontre contre un club jamais croisé (cf. « L'ordre des simples ADVERSES ») |

Trois choses échappent toutefois au membre, et sont réservées à l'**admin** :

- **créer une rencontre** (`POST /api/interclub`, 403 sinon). Le calendrier de la ligue,
  synchronisé par le cron et l'import admin, génère les rencontres ; le bouton « Nouvelle
  rencontre » ne s'affiche qu'à l'admin (`canCreate` renvoyé par `GET /api/interclub`), qui
  garde la main pour ce que la ligue ne publierait pas ;
- **l'appartenance à une équipe** (`POST /api/admin/members`, action `set_team`) — elle décide
  qui peut être aligné, donc s'y inscrire soi-même reviendrait à s'inviter dans une
  composition. La route `PATCH /api/profile` l'a acceptée un temps : c'était une erreur
  d'analogie avec le pseudo, qui n'engage que celui qui le choisit ;
- **le roster des joueurs sans compte** (`/api/admin/interclub-teams`), pour la même raison.

Le contrôle d'accès vit dans **`src/lib/interclub-access.ts`**
(`requireInterclubMember`) — un seul endroit, pour qu'une route future ne puisse pas oublier
le flag. ⚠️ À ne pas confondre avec `interclub-gate.ts`, qui ne parle pas de droits du tout :
c'est le cache du direct.

### La seule exception : le capitaine, et seulement pour l'officiel

Depuis l'**espace capitaine** (`src/lib/captain-access.ts`), il existe **un second rôle** — et
c'est un renversement assumé de tout ce qui précède, borné à un seul endroit.

**Ce qui ne change pas.** Composer une équipe, prendre le marquage, saisir et corriger un score
**interne** restent ouverts à tout membre connecté. La règle du soir de match est intacte : rien
ne se bloque parce que le capitaine joue.

**Ce qui change, et pourquoi.** Le score **officiel** ne vit pas dans l'appli. Un capitaine le
saisit chez la fédération, le capitaine adverse le valide ; ces gestes-là ne se corrigent pas
d'un tap, ils sont visibles de tous les clubs de la poule, et ils engagent celui qui les pose
devant sa ligue. La doctrine ci-dessus réserve déjà ses restrictions à ce qui « protège
quelqu'un d'un **écrasement** » — on y reste, à ceci près que ce qu'on protège est **dehors**.

| Garde | Ce qu'elle empêche |
|---|---|
| `requireCaptain` — capitaine d'au moins une équipe | Qu'un membre découvre un écran dont toutes les routes lui répondraient 403 |
| `requireCaptainOf(teamId)` — capitaine de **cette** équipe | Que le capitaine de l'Équipe 1 agisse sur une rencontre de l'Équipe 2 |

**La portée est l'ÉQUIPE, jamais le club**, et ce n'est pas de la méfiance : l'accès fédéral
d'un capitaine ne couvre que la sienne. Une portée plus large dans l'appli que chez la
fédération promettrait un geste qui échouerait au bout du chemin.

**Les admins passent**, comme partout ailleurs (`isAdminEmail`) : c'est le filet du soir où le
capitaine est injoignable et où la ligue attend un score.

L'onglet « Capitaine » est **absent** pour les autres — pas grisé. Les autres entrées se grisent
quand leur fonction est coupée, ce qui est une information utile (« ça arrive ») ; ici ce serait
l'inverse : annoncer à trente membres une porte que deux personnes peuvent ouvrir.

### Partager la feuille en image (depuis le 16/10/2026)

Le bouton « Partager », au bout de la ligne du compte, fabrique une image PNG de la rencontre
pour le groupe WhatsApp de l'équipe. Elle contient le compte, puis chaque simple : ses deux
joueurs, le détail jeu par jeu et les jeux gagnés. Elle remplace la capture d'écran, pour
laquelle l'écran avait été resserré.

- Le dessin est dans `src/lib/captain-image.ts`, sur le modèle du score d'un match libre
  (`score-image.ts`, dont il reprend l'en-tête et la palette).
- Le partage passe par `src/lib/share-image.ts`, commun aux deux images. Sur téléphone, c'est la
  feuille de partage du système. Sur un ordinateur, le PNG est téléchargé. Sans canvas, la
  feuille part en texte.
- Les noms sont ceux de la fédération, remis en minuscules (« Plenat Thomas »), ou le nom saisi
  quand le joueur n'a pas été rapproché.
- ⚠️ Le bouton fait 30 px de haut, comme le « 3 – 1 » : la ligne du compte garde ses 49 px,
  mesurés à 390 px de large. Plus haut, il repousserait le dernier simple hors de la capture
  d'écran (cf. `.cap-tie` dans `globals.css`).

### Envoyer le score sur squashnet (depuis le 16/10/2026)

Le score officiel ne vit toujours pas dans l'appli, mais elle peut le **transmettre** à la place
du recopiage à la main. Le geste reste celui du capitaine.

L'envoi part de l'écran de vérification, avec le bouton « Envoyer sur squashnet… », et se fait en
**deux temps**, comme l'import du calendrier. La route est
`POST /api/captain/squashnet/[id]`.

1. **`preview`** se connecte à squashnet avec les identifiants du capitaine. Elle lit le
   formulaire de la rencontre (`ic_a=330249`) et montre ce qui partira : l'équipe qui reçoit à
   gauche, les jeux de son point de vue.
2. **`send`** reconstruit l'envoi et refuse s'il diffère de l'aperçu (empreinte `seen`). Elle
   envoie ensuite le formulaire (`330250`), puis **relit** le détail (`330253`) et le compare à
   ce qui est parti. La réussite ne s'annonce qu'après cette relecture.

**L'envoi laisse une trace** (`InterclubOfficial.sentAt`, migration 59), écrite seulement après
une relecture conforme. Rouvrir la rencontre affiche « ✅ Envoyé sur squashnet le 16/10 à 20h00 »
à la place du bouton, en heure du club : squashnet referme son formulaire dès la saisie, et le
bouton ne mènerait qu'au refus « déjà saisie ». La liste dit « ✓ envoyée », sauf si une
revérification postérieure trouve des points à régler. Une saisie faite à la main sur squashnet
ne laisse pas cette trace : c'est la feuille publiée, relue à chaque vérification, qui la montre.

**squashnet n'a pas d'API.** C'est le même `index.php` + `ic_a` que les pages publiques, derrière
une connexion (`/connexion`, `ic_a=131328`). Le jeton `ic_csrf` est exigé dans chaque `POST`.
Les codes et les captures datent du 16/10/2026 :
- `src/lib/squashnet/captain.ts` lit le formulaire et construit l'envoi ;
- `session.ts` tient la session ;
- les captures sont dans `__fixtures__/capitaine-2027-*`.

**Les identifiants squashnet ne sont jamais stockés.**
- Ils transitent dans le corps de la requête et servent à une connexion. Ils ne sont ni
  journalisés, ni répétés dans une réponse.
- La session squashnet meurt avec la requête.
- Côté écran, ils ne vivent que dans l'état de la fenêtre. Les `autocomplete` standards laissent
  le gestionnaire de mots de passe du navigateur les mémoriser, et c'est le seul endroit où ils
  vivent.
- Trois refus de squashnet en 15 min bloquent l'envoi, pour ne pas faire verrouiller le compte
  fédéral (`LoginAttempt`, clés préfixées `squashnet:`).

**Ce qui part, c'est le rapport de vérification**, pas les simples relus en base : c'est ce que
le capitaine a vu. D'où trois refus avant même de contacter squashnet :
- un simple n'est pas terminé ;
- un simple a été modifié **après** la vérification ;
- il n'y a pas de rapport du tout.

⚠️ **« home » dans le rapport, c'est nous, pas le recevant.** Le formulaire met le recevant à
gauche (`h1_`, `sch`). Notre colonne se reconnaît au `teamid` porté par la case « Forfait » de
chaque équipe, jamais à `Interclub.home`. Se tromper croiserait les deux équipes et inverserait
chaque jeu.

⚠️ **L'envoi n'existe qu'en production** (`VERCEL_ENV`). Recette et les prévisualisations
tournent sur la base de dev, alors que squashnet est toujours le vrai : un essai y enverrait des
scores d'essai à la fédération, au nom d'un vrai capitaine. L'aperçu, qui n'écrit rien, reste
ouvert partout, et c'est lui qu'on essaie hors production.

**Tout doute est un refus nommé**, et rien n'est envoyé dans ces cas :
- un joueur absent des listes squashnet ;
- deux options homonymes ;
- un nombre de simples qui diffère ;
- un formulaire illisible.

La saisie à la main reste toujours possible.

**Ce que squashnet impose :**
- La saisie n'est ouverte **que du jour de la rencontre jusqu'à 5 jours après**.
- **Les deux capitaines** peuvent saisir : l'un saisit, l'autre confirme.
- Sans formulaire, la liste des rencontres (`330241`) dit pourquoi : déjà saisie, déjà validée,
  ou pas encore ouverte.

---

## Modèle de données

Six tables (migrations `34_interclub`, `36_interclub_guests`, `37_interclub_notified`,
`38_interclub_order`, `39_interclub_rangm`), plus `AppNotification` (`35_notifications`), qui
sert à toute l'appli et pas seulement ici. La migration `38_` ajoute `User.interclubCltOverride`
— la correction admin d'un classement squashnet mal rapproché ; la `39_` ajoute son pendant pour
le **rang mixte** (`User.interclubRangMOverride`) et donne aux joueurs sans compte les mêmes
deux étages que les membres, en renommant leur `clt` manuel en `cltOverride` (cf. « Ordre des
simples : classement, puis rang mixte » ci-dessous). La `40_squashnet_name` ajoute
`User.squashnetGivenName` / `squashnetFamilyName` : le nom sous lequel **chercher** un membre à
la fédération, à ne pas confondre avec les deux corrections ci-dessus (cf. « Réparer la
recherche avant de forcer la valeur »).

| Table | Rôle |
|---|---|
| `InterclubTeam` | Les équipes de l'asso. Une **table**, pas des colonnes `equipe1/equipe2` : une 3ᵉ équipe ne coûtera qu'une ligne. Semées idempotemment par la migration. |
| `InterclubGuest` | Joueur du championnat **sans compte** sur l'appli. `name`, unique dans son équipe, et son classement à deux étages : le **rapprochement squashnet** (`snClt`, `snRangM`, `snStatus`…) et la **correction admin** (`cltOverride`, `rangMOverride`), prioritaire. « Sans compte » ne veut pas dire « sans licence » : ces joueurs disputent le même championnat, donc la fédération les connaît. |
| `Interclub` | La rencontre. `opponent` est un **texte libre** — on ne tient pas d'annuaire des clubs adverses. `startNotifiedAt` / `doneNotifiedAt` sont des **marqueurs d'annonce**, pas des dates d'affichage : rien ne les lit hors des gardes de notification. |
| `InterclubMatch` | Un simple. Porte `homeUserId` **ou** `homeGuestId` (contrainte `CHECK`, jamais les deux), la prise de marquage, l'instantané du direct (`liveJson`), et sa durée (`startedAt` / `finishedAt`, cf. « La durée d'un simple »). |
| `InterclubGame` | Un jeu **terminé**. `@@unique([matchId, number])`. `finishedAt` : l'heure où le direct l'a vu se finir, NULL pour un jeu saisi après coup. |
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

**Qui engage ?** Le marquage s'ouvre sur cette question — quel joueur, et lui seul. Le
premier service se tire au sort sur le terrain : ni l'appli ni le serveur ne peuvent le
connaître, et le supposer se trompe une fois sur deux. Les deux cases de points restent
**inertes** tant qu'on n'a pas répondu, parce que le moteur ignore un point sans serveur — des
cases actives absorberaient les appuis en silence, sur un écran qu'on utilise sans le regarder.
Un match repris dont des jeux sont déjà enregistrés ne repose pas la question — leur serveur
n'a plus d'importance, et le déroulé que `seedEvents` reconstitue est assumé comme inventé.

**Le carré se propose, il ne se demande plus** (demande du club, 2026-10-16). Un panneau
« carré gauche / droit » bloquait le point suivant à chaque reprise de service — des dizaines de
fois par match. Désormais une pastille **« D? »** apparaît sur la case du serveur : sans appui,
il sert à droite ; un appui la bascule en « G? ». S'il gagne l'échange, elle passe à « G » (ou
« D ») sans point d'interrogation — c'est la règle, plus un choix — et alterne tant qu'il garde
le service ; un appui corrige encore, toujours facultatif. À chaque **reprise** de service, et en
début de jeu, la proposition est le carré que ce joueur a choisi à son **premier** service du
match (`firstBox`) : on commence presque toujours ses séries du même côté. Avant tout service,
à droite. Un appui sur la pastille est un `serve` du même joueur dans le journal : « Annuler »
le défait comme un point.

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

### La durée d'un simple (depuis le 17/10/2026)

Sur la fiche d'une rencontre, chaque simple marqué en direct affiche sa durée à côté de son
numéro (« Simple 1 · 42 min »). Pendant le match, c'est le temps écoulé depuis le premier point,
qui avance tout seul. Une fois tous les simples terminés et mesurés, la rencontre affiche aussi
la sienne, du premier point au dernier (« Terminée en 2 h 35 »). Les règles sont dans
`src/lib/interclub-duree.ts`, un module pur et testé :

- **Seul le direct horodate.** `PUT …/live` pose `startedAt` au passage `pending` → `live`,
  c'est-à-dire au premier point, et `finishedAt` au point décisif. L'heure est celle du
  **serveur**, jamais celle du téléphone. La saisie après coup (`PATCH`) n'invente aucune heure
  et n'en efface aucune : corriger 11-5 en 11-7 ne change pas la durée d'un match bien mesuré.
- **Dans le doute, rien.** Pas de début si la première écriture porte déjà un jeu terminé : le
  téléphone comptait hors ligne et le vrai premier point est perdu. Pas de durée au-delà de
  3 h pour un simple ou de 8 h pour une rencontre : ce serait un oubli, pas un match. Une durée
  fausse se lirait comme une mesure.
- **Annuler défait.** Le premier point annulé efface le début, et le point décisif annulé efface
  la fin. Un renvoi du même état (reprise après coupure) ne déplace rien.
- **Les jeux gardent leur heure.** Les deux routes effacent et recréent la liste des jeux. Avant
  ce changement, chaque jeu recevait l'heure de l'écriture, donc tous portaient celle du
  dernier. Désormais un jeu inchangé (ou corrigé) garde la sienne. Cette heure n'est pas encore
  affichée.

**Pas dans le panneau « En direct ».** Mesuré à 360 px, « #1 · 18 min » faisait chevaucher les
noms et le score de la ligne. La carte ouvre la fiche d'un appui, et la durée s'y lit.

**Le chrono de l'écran de marquage** (`MatchClock`, interclub et marqueur libre). Il se met à
jour chaque seconde à droite de la ligne des jeux (« 18:42 »), part au premier point, se fige au
point décisif, et n'apparaît pas avant. Il suit les mêmes règles (`liveMatchTimes`), mais avec
l'**horloge du téléphone** : il doit partir au premier appui, même sans réseau. Les heures sont
gardées à côté du journal (`ic:time:<match>`), donc un rechargement ne remet pas le chrono à
zéro. Un match repris sur un autre téléphone reprend l'heure du serveur. Le chrono et la fiche
peuvent donc différer de quelques secondes, le temps d'une synchro.

Il loge dans la ligne des jeux, et non dans l'en-tête, parce que cette ligne a déjà sa hauteur
réservée. Dans l'en-tête, il aurait ajouté une ligne au rappel du match au premier point, et le
tableau aurait sauté. ⚠️ Cette réserve était d'ailleurs fausse : `min-height: 1.3em` contre une
ligne de texte en `1.5em` héritée de Pico, mesuré 23,2 px vide et 26,8 px pleine. Le tableau
sautait donc déjà de 0,2em au premier jeu terminé. `.ics-history` porte maintenant sa propre
hauteur de ligne (1.3), et la ligne fait la même hauteur dans les cinq cas mesurés.

**Marqueur libre.** Même chrono pendant le match. Le match terminé garde ses deux heures
(`firstPointAt`, `finishedAt` dans `FreeMatch`, sur le téléphone), ce qui donne « Match terminé en
42 min », la durée dans l'historique et sur l'image partagée. Les matchs d'avant ce changement
n'en ont pas.

Les matchs joués avant ce changement n'ont aucune heure exploitable et n'afficheront jamais de
durée.

### Au bord du terrain — ce que l'écran fait sans qu'on le lui demande

Quatre conforts, tous **facultatifs par construction** : le marquage fonctionne exactement
pareil quand chacun d'eux est refusé, et aucun ne dit rien quand il échoue. Personne ne doit
recevoir un message d'erreur pendant qu'il compte des points.

| Ce que ça fait | Où | Quand ça n'a pas lieu |
|---|---|---|
| **L'écran reste allumé** tant que le marquage est ouvert, et le verrou est **repris au retour au premier plan** | `lib/wake-lock.ts` | API absente (Firefox Android), batterie faible, réglage système |
| **Balle de jeu / balle de match** au coin haut-droit de la case | `ballPoint` (`lib/interclub.ts`) | jamais à 10-10 : 11-10 ne gagne pas le jeu |
| **Vibration** brève sur un point, double sur une fin de jeu | `InterclubScorer` | iOS ne connaît pas l'API |
| **Ni zoom au double-appui, ni sélection du nom** sur les deux grandes cases | `.ics-side` | — |

Le premier est celui qui change le plus l'usage réel : un téléphone posé au bord du court se
verrouille au bout de trente secondes, et le marqueur le déverrouillait entre **chaque échange**.
Rien dans le code ne le montrait — l'appli fonctionnait parfaitement.

⚠️ **30 ms, et non 12.** `vibrate` ne pilote que la **durée**, jamais l'intensité, et les moteurs
à résonance linéaire des téléphones récents mettent quelques dizaines de millisecondes à monter en
amplitude : en dessous, l'ordre est fini avant que le moteur ait démarré et on ne sent rien. La
valeur du Fil (12 ms) a été reprise au premier essai, et ne se sentait pas — là-bas c'est un tic
discret sur un écran qu'on regarde, ici c'est la seule confirmation d'un geste fait en regardant
ailleurs.

⚠️ **Les quatre panneaux passent PAR-DESSUS le tableau** (`.ics-ask`, `position: absolute`, en bas
de l'écran). Ils en étaient des frères : chaque apparition — « Qui engage ? », le carré de service,
la pause, la fin de match — prenait sa hauteur au tableau, et comme toute la typographie des deux
cases se règle en **requêtes de conteneur sur la case elle-même**, le score changeait de taille à la
fin de chaque jeu, à chaque reprise de service et au coup de sifflet final. Même raison pour la
ligne des jeux terminés, désormais toujours rendue avec un `min-height` : elle n'apparaissait qu'au
premier jeu gagné, et faisait sauter le tableau exactement à ce moment-là. La garde est dans
`globals.css.test.ts` — jsdom ne calcule aucune mise en page, un test de DOM ne peut pas la tenir.

⚠️ **La règle des balles n'est pas réécrite** : `ballPoint` ajoute un point au camp considéré et
demande à `gameWinner` si le jeu serait fini. Une seconde copie du « 11 points et 2 d'écart »
finirait par diverger, et l'écart ne se verrait qu'à 10-10 — devant tout le court.

⚠️ **Le choix du premier serveur se défait.** Il ne se défaisait pas : la garde du bouton
« Annuler » était `events.length <= 1`, or sur un match vierge le « Qui engage ? » pose
l'événement n° 1. Un appui de travers condamnait l'indicateur de service pour tout le match (le
score, lui, n'était pas touché), et marquer un point puis l'annuler n'y changeait rien. Cette
garde ne protégeait rien d'autre — on pouvait déjà défaire un par un tous les événements
reconstruits d'un match repris.

### Qui sert, côté spectateur

Une pastille (`.ic-au-service`) à droite du nom, dans le panneau « En direct » **et** sur la
fiche d'une rencontre. La donnée arrivait déjà dans la charge utile (`live.serving`, cf.
`getLiveFixtures`) et les deux écrans la déclaraient dans leur type sans jamais la rendre : coût
serveur **nul**. Au squash le service change de main à chaque échange perdu, et c'est lui qui dit
si le meneur est en train de conclure ou de subir — « 7–5 » seul ne le dit pas.

Elle ne se confond pas avec la pastille de **maillot** : celle-ci est à gauche du nom, pleine et
colorée ; celle-là est à droite, moitié moins grande, et prend l'encre du texte — elle dit un
état du jeu, pas une identité. Rien n'est affiché tant que le premier serveur n'est pas désigné.

---

## Ordre des simples : classement, puis rang mixte

Règle de la compétition FFSquash, pas une préférence de l'appli : **le mieux classé des joueurs
présents joue le simple n° 1**, et les suivants s'enchaînent en ordre décroissant.
Concrètement, si Albert (classé `5A`) joue le simple 1, Benoît (classé `4D` — mieux classé que
`5A` malgré la lettre, le CHIFFRE domine toujours) ne peut jouer **aucun** simple de cette
rencontre : l'aligner casserait l'ordre quel que soit le numéro qu'on lui donnerait.

**DEUX critères, pas un.** À classement ÉGAL (deux `5A`), c'est le **rang mixte** (`rangM`) qui
départage, le plus petit devant. Deux `5A` ne sont donc pas interchangeables dès que leurs rangs
diffèrent. Cette page a longtemps affirmé le contraire (« `RangM` n'intervient jamais ici ») :
c'était faux, et une rencontre composée sur cette base est sanctionnable au même titre qu'un
classement inversé.

**La seule exception est `NC`.** Les non-classés sont équivalents entre eux : la fédération ne
les ordonne pas. Un `NC` est donc alignable **sans** rang mixte connu ; tout autre classement
exige les deux, faute de quoi le joueur ne peut disputer aucun simple.

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
  règle d'ordre RELATIF, elle n'a par construction rien à dire sur un simple isolé. Trois causes
  de refus, dans cet ordre : classement inconnu, rang mixte inconnu (hors `NC`), ordre violé ;
- `isNC(clt)` — la seule valeur que le rang mixte ne départage pas. Jamais dérivé d'un
  `classementPower === Infinity` : le poids est un détail de la comparaison, pas une identité ;
- `parseRangMInput(v)` — le pendant de `parseClassementInput` pour le rang. Tolère l'espace de
  milliers (« 2 339 », la forme que squashnet affiche et qu'un admin recopie), refuse zéro et le
  négatif (un « 0 » est une case vide déguisée, qui placerait son joueur EN TÊTE de l'ordre).

⚠️ **Ce n'est PAS la même chose que « avoir le droit de jouer ».** Un joueur dont le classement
est **inconnu** (`clt === null` — jamais rapproché sur squashnet, et aucune correction admin
posée), ou dont le **rang mixte** manque alors qu'il n'est pas `NC`, ne peut disputer **aucun**
simple, y compris le tout premier composé d'une rencontre, où `lineupOrderConflict` seule ne
réclamerait rien faute de second joueur à comparer. Cette exigence-là vit dans
`interclub-roster.ts` (`rankingRefusal`, appelée par `decideMember`/`decideGuest`, elles-mêmes
appelées par `resolveHomePick`/`resolveHomePicks`) : composer QUELQUE joueur que ce soit passe
TOUJOURS par elles, avant même que `findOrderConflict`/`lineupOrderConflict` n'aient leur mot à
dire — donc avant que le nombre de simples déjà désignés entre en jeu. Un classement **connu
mais faible** (`NC`) reste, lui, un classement valide, et dispense de surcroît du rang mixte.

**Pourquoi exiger le rang même sans ex æquo à l'écran** : ne le réclamer qu'en cas d'égalité
ferait surgir le refus au troisième joueur composé, pour une donnée manquante depuis le premier.
C'est un piège, pas une règle.

**D'où viennent le classement et le rang d'un joueur** (`interclub-roster.ts`, `RosterEntry` /
`ResolvedPick`) — même structure des deux côtés du roster, une correction ADMIN prioritaire
au-dessus d'un RAPPROCHEMENT automatique :
- un **membre** : `User.interclubCltOverride` / `interclubRangMOverride` si posés, sinon
  `SquashnetRanking.clt` / `.rangM` ;
- un **invité** (`InterclubGuest`, sans compte) : `cltOverride` / `rangMOverride` si posés,
  sinon `snClt` / `snRangM`.

Les deux corrections sont **indépendantes** : forcer un classement laisse le rang rapproché en
place, et réciproquement. Un membre fraîchement monté de série garde ainsi son rang squashnet
sans qu'un admin ait à le recopier.

**Le classement d'un joueur sans compte se CHERCHE, il ne se saisit plus d'abord.** « Sans
compte » ne veut pas dire « sans licence » : ces joueurs disputent le même championnat, donc
squashnet les connaît. L'inscription au roster déclenche le rapprochement sur-le-champ
(`matchGuestRanking`, `lib/squashnet/refresh.ts`) et l'écran RAPPORTE le verdict — c'est le seul
moment où le nom est encore sous les yeux de l'admin, donc le seul où « pas trouvé » est
actionnable (corriger l'orthographe, ou forcer le classement). Le cron mensuel les rafraîchit
ensuite comme les membres.

### Réparer la recherche avant de forcer la valeur

Quand la fédération ne retrouve pas un membre, le premier réflexe n'est **pas** de forcer son
classement à la main : c'est de réparer la **recherche**. Le rapprochement par défaut suppose
« Prénom Nom » et n'interroge squashnet que sur le **dernier mot** du nom affiché. ResaMania ne
garantit ni l'ordre ni l'orthographe : là où il a enregistré « Nom Prénom », on interroge la
fédération sur un prénom, la réponse déborde, et le verdict est « introuvable » **tous les
mois**, sans que rien ne le signale.

`set_squashnet_name` (`POST /api/admin/members`) pose donc deux champs par membre, sur
`/admin/membres` : le **prénom** et le **nom de famille** tels que squashnet les connaît. Le
nom de famille devient le terme envoyé à la fédération ; le prénom sert à départager les lignes
rendues.

⚠️ **Ce n'est pas un renommage.** `displayName` vient de ResaMania et y est **réécrit à chaque
connexion** du membre (`lib/session.ts`, `resolveUser`) : le corriger localement ne tiendrait
pas une journée. Ces deux colonnes ne servent **qu'à** la recherche fédérale.

⚠️ **Les deux moitiés ou aucune.** N'en donner qu'une rendrait le rapprochement *plus permissif*
que le comportement par défaut — l'inverse du but. La route le refuse, et `refresh.ts` le
revérifie avant de s'en servir : une ligne à moitié remplie retombe sur le nom affiché.

Et parce qu'un rapprochement ne repasse qu'une fois par mois, l'écriture **relance le
rapprochement sur-le-champ** (`refreshMemberRanking`) et l'écran rapporte le verdict. Sans cela,
l'admin saisirait un nom sans savoir s'il est le bon, et l'apprendrait au prochain cron. La
carte affiche par ailleurs un « jamais retrouvé sur squashnet » **permanent** tant qu'aucun
rapprochement n'a abouti : c'est ce silence-là qui laissait passer le défaut.

⚠️ **Les deux champs se tapent l'un après l'autre, et doivent se voir.** L'écran garde donc un
BROUILLON par membre : juger chaque moitié contre le seul état venu du serveur rendait le
formulaire inerte — le prénom refusé faute de nom, puis le nom refusé parce que le prénom
n'avait jamais été envoyé, sans un mot à l'écran. Une saisie à moitié le dit désormais, et
`refreshMemberRanking` distingue une **panne** (`error`) d'une **absence** (`unknown`) : dire
« introuvable » quand squashnet est muet, c'est accuser la fédération d'un défaut qui est chez
nous, et envoyer l'admin corriger une orthographe déjà juste.

Un bouton **« Re-rapprocher »** (`rematch_squashnet`) retente sans rien modifier — le pendant
exact de `rematch_guest` côté joueurs sans compte. Il existe parce que `set_squashnet_name` ne
rapproche qu'au **changement** du nom, alors qu'un échec n'accuse pas toujours le nom :
squashnet muet ce jour-là, licence pas encore publiée, mois pas encore paru. Sans lui, réessayer
voudrait dire modifier le nom pour le remettre aussitôt.

Reste le cas où la fédération ne connaît vraiment pas la personne (pas encore licenciée) : alors
seulement, on force la valeur.

### Forcer la valeur, en dernier recours

**La correction admin existe pour un cas réel** : un rapprochement squashnet qui échoue ou se
trompe, ou un joueur pas encore licencié. Deux écrans :
- `/admin/membres`, action `set_clt_override` (`POST /api/admin/members`) — un `<select>` de
  classement et un champ de rang par membre, à côté du switch d'équipe interclub ;
- l'espace admin, section « Équipes interclub », actions `add_guest` / `rematch_guest` /
  `set_guest_ranking` (`POST /api/admin/interclub-teams`) — les champs de correction n'y
  apparaissent que lorsqu'ils servent (joueur non rapproché, ou déjà forcé) ; un joueur retrouvé
  n'offre qu'un bouton « Actualiser », pour ne pas inviter à écraser une donnée juste.

Les deux valident le format en écrivant (`parseClassementInput` / `parseRangMInput`, même
module) : une faute de frappe se signale à la SAISIE, pas le soir d'une rencontre au moment de
composer. Et comme la liste FFSquash est fermée, ils ne proposent que `KNOWN_CLASSEMENTS` — un
classement inventé n'est plus saisissable du tout, au lieu d'être refusé après coup.

⚠️ **Une correction n'est JAMAIS écrite dans les colonnes du rapprochement**, et le
rafraîchissement mensuel ne touche jamais aux colonnes de correction. Sans cette séparation, le
run suivant écraserait la correction de l'admin — ou, symétriquement, une correction ancienne
figerait un classement que la fédération a fait bouger depuis.

**L'EFFECTIF d'une équipe se lit en entier dans l'espace admin** (section « Équipes interclub »).
Cet écran ne montrait qu'un DÉCOMPTE de membres (« 7 membres inscrits ») et la liste des seuls
invités : savoir qui composait réellement une équipe, et à quel classement, obligeait à ouvrir
`/admin/membres` à côté et à reconstituer l'équipe de tête. `GET /api/admin/interclub-teams`
renvoie donc aussi les membres nominativement (`allTeamMembers`, `interclub-roster.ts` — mêmes
règles que `teamRoster` : comptes désactivés exclus, classement effectif via `memberClt`), et
l'écran affiche membres ET invités dans UNE liste triée par `compareRosterOrder`, du mieux au
moins bien classé — c'est-à-dire dans l'ordre où ils devront disputer les simples. Le
RATTACHEMENT, lui, reste sur `/admin/membres` : ici on lit les membres (classement, rang mixte,
ou « classement inconnu » / « rang inconnu » qui disent tout de suite qu'ils ne pourront
disputer aucun simple), on n'édite que les invités. **Ce qui manque se dit**, plutôt que de
laisser un blanc : une ligne muette ne se découvre bloquante que le soir d'une rencontre.

**LES JOUEURS SANS COMPTE FIGURENT DANS L'ANNUAIRE** (`GET /api/directory`), mêlés aux membres
dans la même liste triée par nom. Les en tenir dehors donnait une photo fausse de l'effectif :
on y cherchait quelqu'un vu jouer la veille, et il n'existait pas. Trois conséquences :

- chaque entrée porte un `kind` (`"member"` / `"guest"`), et l'identifiant d'un joueur sans
  compte est préfixé `guest:` — rien ne garantit qu'il ne ressemble pas à un identifiant de
  compte, et les deux populations partagent désormais des clés de liste ;
- `kind` n'est **pas** décoratif. Tout écran qui propose une action supposant un COMPTE — la
  délégation de droits (`SettingsButton`), les têtes de série d'un tournoi (`Tournament`) — doit
  écarter ces joueurs via `accountHolders` (`lib/directoryCache.ts`). Leur tendre une action que
  le serveur refuserait serait une promesse en l'air ;
- l'annuaire ne les lit **que si le flag interclub est actif** : ils n'existent que par lui, et
  le flag à `0` doit rendre le roster aussi invisible que l'onglet qui le sert.

L'annuaire ne propose plus qu'UN filtre, l'**équipe** (« Tous · Éq. 1 · Éq. 2 », dérivé des
joueurs chargés et non d'une liste figée). Les deux filtres précédents — classement et catégorie
d'âge — ont été retirés : ils occupaient une ligne entière d'un écran de téléphone pour répondre
à des questions qu'on ne se pose pas devant un annuaire de club, là où la recherche par nom fait
déjà l'essentiel du travail.

**La correction admin d'un membre est aussi visible dans l'annuaire** (`GET /api/directory`) :
`clt` ET `rangM` y suivent la même priorité qu'en composition (override d'abord, rapprochement
squashnet sinon) — sans quoi un membre jamais rapproché (pas encore licencié, nom mal
orthographié…) resterait sans badge de classement, et à une place de tri que plus rien ne
justifie, alors qu'il a désormais les deux pour l'interclub. `rang` (le rang DANS SON GENRE, qui
ne sert qu'aux têtes de série du tournoi) et `cat` ne viennent QUE du rapprochement : aucun
écran ne propose de les corriger.

**Vérifié à l'écriture, jamais figé.** Contrairement à `homeDisplayName`, le classement n'est PAS
stocké sur `InterclubMatch` : `findOrderConflict` (`interclub-roster.ts`) le relit à chaque
composition, contre les AUTRES simples de la rencontre. Un classement qui change ensuite (le
rafraîchissement mensuel squashnet) ne revalide donc pas rétroactivement une composition déjà
enregistrée — exactement le même parti pris que le reste du module (cf. « Le nom du joueur est
figé » plus haut, pour la raison symétrique).

---

## Calendrier, capitaines et disponibilités

Jusqu'ici l'appli savait composer une équipe et marquer les points, mais pas **quand on joue**
ni **qui peut venir** : la rencontre n'avait qu'une date, sans heure ni lieu, et rien nulle part
ne recueillait une disponibilité. Les capitaines faisaient ce travail sur WhatsApp, à la main,
et recommençaient à chaque journée.

### Le calendrier vient de la fédération, en un geste

La ligue publie le calendrier d'une saison **en une fois**. Un bouton d'admin le récupère
(`POST /api/admin/interclub-calendar`), un cron hebdomadaire vérifie ensuite qu'il n'a pas
bougé. Même mécanique que le classement : un POST sur `https://www.squashnet.fr/index.php`,
section `ic_a=393986`, qui rend un fragment HTML rendu serveur.

Trois constats du site ont décidé de la conception, et ils se vérifient dans
`src/lib/squashnet/calendar.test.ts` sur un fragment réel :

1. **Une épreuve contient PLUSIEURS POULES, et `teamid` ne filtre rien.** Deux pièges distincts
   qui se cumulent. D'abord `roundid` : sans lui, la fédération rend la poule qu'elle veut —
   mesuré sur notre propre critérium, celle de Jeu de Paume, Montmartre, PUC et Vincennes, où
   l'Yvette ne figure pas. Ensuite `teamid`, qui ne filtre pas : on reçoit la poule entière, et
   c'est `ownFixtures()` qui retient les lignes portant notre `data-teamid`. D'où **quatre**
   identifiants à renseigner par équipe (`snEventId`, `snDrawId`, `snRoundId`, `snTeamId`) —
   le quatrième, la division, n'est arrivé qu'avec le classement, cf. plus bas.

   La panne que ça évite est la plus vicieuse de toutes : sans la poule, l'import ne lève
   aucune erreur, ne rend aucun 502, et annonce simplement « 0 rencontre publiée » — ce qui
   ressemble exactement à une ligue qui n'a pas encore publié. La poule se lit sur la page
   « Équipes » de l'équipe, dans le code du tableau (`<table id="round_370138">`).
2. **Les journées non planifiées portent une date bouchon**, commune à plusieurs journées.
   Importée telle quelle, elle convoquerait l'équipe quatre fois le même soir. Plusieurs
   journées à la même date ⇒ `dateConfirmed: false`, la date s'affiche comme
   **prévisionnelle**, et **aucune notification ne part** dessus.
3. **Le jour de la semaine n'est pas garanti** — l'événement d'essai se joue le mardi, pas le
   jeudi. Rien ne code un jour en dur : la date vient du calendrier fédéral, et les vacances
   scolaires n'entrent nulle part dans le calcul (la ligue les a déjà retirées).

**Le parseur est éprouvé sur le vrai calendrier de l'équipe.**
`src/lib/squashnet/calendar.reel.test.ts` fige le fragment réel du critérium 2025-2026 (Hommes 4,
poule IVD) capté sur squashnet, et vérifie les cinq journées de l'Yvette : leurs dates, leurs
adversaires, domicile/extérieur, les gymnases, l'heure. C'est ce fichier qui a révélé l'affaire
de la poule — un parseur vert sur des fragments d'école et muet sur la seule épreuve qui nous
concerne n'aurait rien prouvé.

Il documente au passage un cas que le modèle prévoyait sans l'avoir jamais vu : **J01 se joue
APRÈS J02, J03 et J04** (le 15 juin, contre le 28 mai pour J02). La journée et la date ne vont
pas dans le même ordre — c'est la justification, en vrai, du rapprochement par journée.

**L'import se fait en deux temps, `preview` puis `apply`.** Ce qu'il écrit n'est pas une donnée
d'affichage : c'est la date à laquelle une équipe se déplace. Un scraping qui casse — squashnet
a déjà changé son rendu du jour au lendemain — ne doit pas pouvoir vider un calendrier tout
seul. L'admin voit l'écart champ par champ, puis applique.

**Le rapprochement se fait par JOURNÉE (`round`), pas par date** : la date est précisément ce
qui bouge, et rapprocher par elle créerait une rencontre de plus à chaque report au lieu de
corriger l'existante. **Une rencontre saisie à la main (`snMatchKey` nul) est intouchable par
l'import** — même doctrine que les corrections de classement : l'automatique et l'humain ne
partagent aucune colonne.

⚠️ **Une équipe, une rencontre par jour — les doublons ne se tranchent pas à l'écran.** Le
15/10/2026, J2 contre CAL Squash a existé deux fois : la rencontre importée, avec les réponses de
disponibilité, et une seconde créée au bord du terrain, avec les scores. Aucun écran ne permet
de fusionner deux fiches ; il a fallu le faire en base. Deux gardes, une par ordre d'arrivée :

- **création après import** — `POST /api/interclub` refuse en `409 same_day` une rencontre de la
  même équipe à la même date, en désignant l'existante. Le formulaire le dit avant d'écrire
  (« Ouvrir cette rencontre ») ; « Créer quand même » envoie `force` pour la double journée réelle.
- **import après création** — `diffCalendar` **rattache** (`toAdopt`) la journée publiée à la
  rencontre manuelle quand c'est la **seule** de l'équipe ce jour-là : il pose la clé et la
  journée, comble les champs vides, et ne réécrit rien de ce qu'un humain a saisi. Deux manuelles
  le même jour : il crée, comme avant, plutôt que de choisir. Si la rattachée diffère encore
  (côté, adversaire), l'empreinte n'est pas posée et l'alerte du lundi le resignale.

**Une date qui change efface les disponibilités de la rencontre** et remet l'appel à zéro.
« Je suis dispo le 9 » ne veut pas dire « je suis dispo le 16 », et ce sont précisément les
soirs de report qu'on se retrouve à trois.

⚠️ **Les TROIS marqueurs, et la liste ne s'écrit qu'à un endroit.** Les deux chemins qui
déplacent une rencontre (le `PATCH` d'une fiche, l'import du calendrier) les énuméraient chacun
à la main, et tous deux avaient oublié le troisième : `eveRemindedAt` n'était remis à zéro nulle
part. `dueAction` étant une cascade, un marqueur resté posé ferme sa branche définitivement :
l'appel se rouvrait bien sur la nouvelle date et la relance repartait, mais le rappel de la
veille **ne partait plus jamais** — sur la rencontre même où on a le plus besoin qu'on nous
redise où et quand. La liste vit désormais dans `MARQUEURS_A_REARMER`
(`lib/interclub-availability.ts`), posée **contre la cascade qui la lit**, pour que les deux se
modifient du même geste.

### Ce que la rencontre rapporte — le nul 2-2, et qui le gagne

**En 2026-27, la division 4 passe de CINQ simples à QUATRE.** Ça n'a l'air de rien et ça change
la moitié des issues : à cinq matchs, un nul était arithmétiquement impossible ; à quatre, le
2-2 devient courant. Or deux rencontres affichées « 2-2 » ne valent pas la même chose au
classement.

Le barème de la ligue Île-de-France :

| Issue | Points |
|---|---|
| Victoire | 3 |
| **Nul gagné** (`E+` au classement fédéral) | **2** |
| **Nul perdu** (`E-`) | **1** |
| Défaite | 0 |

et le départage d'un nul se fait à l'**average de jeux**, puis — **à jeux égaux seulement** — à
l'**average de points**.

L'ordre n'est pas un détail. Il a été vérifié en recalculant les dix-sept rencontres nulles de
la poule Hommes 1 du critérium 2025-26 contre le classement officiel : sur CLOUD1–PUC1, les
jeux donnaient l'un (9-8) et les points l'autre (153-161), et c'est le gagnant **aux jeux** qui
a reçu les deux points. Prendre les points d'abord aurait désigné le mauvais vainqueur.

`tieOutcome()` (`src/lib/interclub-db.ts`) est la seule définition de cette règle : la liste et
la fiche l'appellent toutes deux, pour qu'aucun écran ne puisse annoncer des points de
classement que l'autre contredirait.

**Deux garde-fous dans cette fonction, et ils comptent :**

- **Rien n'est rendu tant que la rencontre n'est pas finie.** Un 2-1 en cours annoncé
  « Victoire, 3 pts » serait faux le temps d'un match — c'est-à-dire pendant toute la soirée où
  l'on regarde l'écran.
- **Les points de jeu sont TUS quand le détail est incomplet.** Un match saisi « 3-1 » sans son
  jeu par jeu rendrait un total partiel, qu'on lirait comme un total. Sur le chiffre qui
  départage, un total faux ne fait pas qu'induire en erreur : il désigne le mauvais vainqueur.
  D'où le contrôle `jeux.length === gamesHome + gamesAway`, match par match.

À l'écran, la carte d'une rencontre terminée porte le verdict, ce qu'il rapporte, et **les deux
averages — celui qui a tranché en encre du thème, l'autre en gris**. Sans ce repère, « Nul
gagné » a l'air d'une décision arbitraire de l'appli.

### Le classement de la poule

**Quatre identifiants d'ancrage, pas trois.** Le calendrier se contente de l'épreuve, de la
poule et de l'équipe ; le classement en exige un quatrième, la **division** (`snDrawId`,
« Hommes 4 » = `47760`).

Ce n'est pas un raffinement. Sur `ic_a=394242`, **`roundid` est ignoré tant qu'on ne dit pas de
quelle division la poule fait partie**, et la fédération rend alors la division 1. Mesuré en
demandant la poule IVD : la réponse était le classement de Squash Pyramides, Montigny et
Vincennes — huit équipes, dix-huit colonnes, aucune erreur, et pas une ligne qui nous concerne.
C'est pire que la panne muette de la poule sur le calendrier, où l'import annonçait au moins
« 0 rencontre » : **ici le résultat a l'air juste**, et on l'afficherait tel quel.

Les quatre vont donc ensemble ou pas du tout, garde tenue par la route d'admin.

| Paramètre | Ce qu'il désigne | Où le lire |
|---|---|---|
| `eventid` | l'épreuve | URL de la page « équipes » |
| `drawid` | la **division** | liste « Tableau/Division » de la page « Classement et rencontres » |
| `roundid` | la poule | code du tableau de la poule (`round_370138`) |
| `teamid` | notre équipe | URL de la page « équipes » |

**Le parsing s'accroche aux `data-label`, pas aux colonnes.** Le tableau fédéral en compte
dix-huit dans un ordre que rien ne garantit, et chaque cellule porte son intitulé
(`<td data-label="J+">`). Une colonne insérée en tête décalerait un parsing positionnel **sans
rien casser de visible** : on lirait les jeux à la place des matchs, et le classement affiché
serait faux mais crédible. Un test fige cette propriété en inversant l'ordre des colonnes.

**Le classement est mis en cache, et sa date est affichée.** Il ne bouge qu'après une journée de
championnat ; l'aller chercher à chaque ouverture ferait dépendre une page quotidienne de la
disponibilité de squashnet. Il est donc rafraîchi par **la passe hebdomadaire qui contrôle déjà
le calendrier** — pas de nouveau cron — et stocké sur `InterclubTeam`
(`snStandingsJson` / `snStandingsAt`). Le rafraîchissement vit dans son propre `try` : un
classement indisponible ne doit pas emporter le contrôle du calendrier, qui est la raison d'être
de ce cron.

Trois refus, tous pour la même raison — **ne jamais remplacer une donnée valide par du vide** :

- un classement de **zéro ligne** n'est pas écrit (c'est une poule non publiée, ou un ancrage
  faux) ;
- un **échec réseau** ne touche à rien ;
- un **JSON illisible** en base rend `null` au lieu de faire tomber tout l'écran interclub — la
  colonne est du texte, et un `JSON.parse` qui explose dans la sérialisation emporterait les
  rencontres, les équipes et le direct pour un tableau annexe.

**Un bouton « Relire le classement » double le cron dans l'admin.** La passe ne tourne que le
lundi : sans lui, celui qui vient de saisir l'ancrage attendrait jusqu'à six jours pour
découvrir qu'il s'est trompé de division — précisément l'erreur qui rend un tableau crédible.

À l'écran, le classement se place **entre le filtre d'équipe et la liste des résultats**, replié
par défaut, un par équipe concernée par l'onglet : c'est là que naît la question « on est où ? », et le résumé y répond
déjà (« 2e sur 6 · au 4 sept. ») pour que déplier reste un choix.

**Notre ligne est reconnue par `snTeamId`, jamais par le nom.** La ligue écrit « Squash de
l'Yvette » là où nous écrivons « Équipe 2 » ; un rapprochement par nom ne surlignerait jamais
rien, ou surlignerait la mauvaise ligne le jour où deux équipes du club jouent la même poule.
Sans ancrage, aucune ligne n'est surlignée — visible, et préférable à une ligne fausse mise en
avant.

**Huit colonnes et pas dix-huit** (`# Équipe J V E+ E- D Pts`) : le reste est illisible sur un
téléphone. Les averages qui départagent — matchs, jeux, points — sont donnés **en toutes
lettres sous le tableau, pour notre équipe seulement**, là où ils se lisent.

### La fiche d'une équipe de la poule

**Toucher une équipe du classement** — n'importe laquelle, les nôtres comprises — ouvre sa
fiche, sur le modèle de l'appli Squash App : ses **rencontres** et leurs scores, le **détail**
d'une rencontre (les quatre simples, jeu par jeu, totaux de jeux et de points), son
**effectif**, et la **fiche d'un joueur** (ses matchs de l'épreuve). Une seule modale, une pile
de vues : la flèche remonte d'un cran, la croix referme tout (`InterclubTeamSheet.tsx`).

- **Les rencontres viennent du fragment du classement** (`squashnet/pool.ts`) : relues avec lui,
  par les mêmes déclencheurs, et rangées par poule dans `SquashnetPool`. Zéro requête de plus.
- **L'effectif** est la fiche d'équipe déjà en cache pour les adversaires (`SquashnetTeamRoster`,
  7 jours), qui garde désormais le `regiid` de chaque inscrit.
- **La fiche joueur** (`squashnet/player.ts`, cache `SquashnetPlayer`, 6 h). Faute de fiche, ses
  matchs dans nos poules, tirés des rencontres (`source: "poule"`, dit à l'écran).
- **Afficher d'abord, relire ensuite** : `GET /api/interclub/poule/{equipe,joueur}` rend la base
  tout de suite ; s'il répond `stale`, l'écran appelle `POST`, qui relit au plus la poule (si
  elle a plus de 6 h) et l'effectif, ou la fiche joueur — avec le repos de 15 min après échec.
- **Pas de relais vers squashnet** : l'équipe doit figurer au classement d'une de nos poules, le
  joueur dans une rencontre ou un effectif rangé. Sinon 404, sans requête fédérale.

**Depuis le tableau des statistiques**, toucher un joueur du club ouvre ses matchs : date,
adversaire et son équipe, gagné ou perdu, score de notre point de vue (la feuille l'écrit côté A,
retourné quand nous sommes B). La liste voyage avec le palmarès (`PlayerStatRow.matches`),
calculée dans la même boucle : elle compte toujours MJ lignes, dont V gagnées.

### Le capitaine — une désignation, et depuis peu un droit (mais un seul)

Nommé par un admin (`set_captain`), affiché sur son équipe et sur chaque rencontre. Il **ne peut
rien de plus** que les autres **sur le jeu** : composer reste ouvert à tout membre, et
verrouiller créerait un point de blocage le soir où le capitaine n'est pas là. Ce qu'il apporte
est ailleurs — l'équipe sait à qui parler, et **lui seul** reçoit le récapitulatif des
disponibilités et les alertes de calendrier. Diffusées à tous, ces deux-là deviendraient un
bruit que chacun ignore.

⚠️ **Une exception, arrivée avec l'espace capitaine** : ce qui touche au score **officiel**
(chez la fédération) lui est réservé, et à sa seule équipe. Voir « Autorisations › La seule
exception » en tête de ce document — c'est là qu'est écrit pourquoi.

### L'ordre des simples ADVERSES

La règle du classement (le mieux classé joue le simple n° 1) vaut pour les deux équipes.
L'appli la fait respecter à notre composition depuis toujours — `lineupOrderConflict` refuse la
saisie. L'espace capitaine l'applique désormais **en face**, sur les mêmes lignes de code :
`checkAwayOrder` (`captain-check.ts`) trie les adversaires rapprochés et délègue le verdict à
`lineupOrderConflict`. Deux copies de cette règle finiraient par diverger, et l'appli refuserait
chez nous ce qu'elle tolère en face.

**Trois états, et le troisième n'est pas une faute** (`OrderStatus`) :

| État | Quand | Ce que l'écran en fait |
|---|---|---|
| `ok` | tous rapprochés, ordre conforme | **rien** — un ordre correct n'apprend rien |
| `violation` | tous rapprochés, ordre rompu | signalé en rouge, formulé « À vérifier sur la feuille de match » |
| `unverifiable` | un seul adversaire non rapproché | note grise, aucun jugement |

⚠️ **Pourquoi `unverifiable` existe.** Le classement des adversaires ne nous est pas donné : il
vient de NOTRE rapprochement, sur un nom recopié à la main sur une feuille de match. Conclure
« leur composition est irrégulière » sur une base incomplète enverrait un capitaine contester
une composition parfaitement régulière — un coût sans commune mesure avec celui de se taire. Un
seul adversaire manquant suffit donc à ne rien conclure, **même si l'écart est visible entre les
autres**. Et un `unverifiable` ne compte pas dans les « points à régler » : le joueur non
rapproché qui en est la cause y est déjà compté.

#### Le blocage se fait à la DÉSIGNATION, pas à la vérification

`checkAwayOrder` constate, la veille de la feuille de match. La rencontre est alors jouée : il
n'y a plus rien à corriger, seulement une sanction à contester. Le refus tombe donc désormais
**au moment où on désigne l'adversaire** — `awayLineupConflict`
(`src/lib/interclub-opponents.ts`), sur `POST /api/interclub` comme sur `PATCH …/matches/{mid}`,
et l'écran grise d'avance ce que la route refuserait. La règle n'est pas réécrite : elle délègue
à `lineupOrderConflict`, celle-là même qui refuse notre propre composition.

⚠️ **On ne refuse que ce qu'on CONNAÎT**, et c'est la différence irréductible avec notre camp.
`lineupOrderConflict` refuse un joueur sans classement — juste chez nous, où un admin peut le
renseigner ; absurde en face, où personne ne le peut. Ce serait rendre impossible d'inscrire une
première rencontre contre un club jamais croisé, c'est-à-dire le cas le plus banal d'un début de
saison. Dès qu'**un seul** adversaire désigné nous est inconnu, on ne conclut rien.

#### D'où vient ce qu'on sait d'eux

**D'aucune requête fédérale.** Deux sources déjà en base, fusionnées par `mergeOpponents` :

| Source | Ce qu'elle donne |
|---|---|
| `InterclubMatch.awayName` | tous les adversaires jamais alignés contre nous — le nom, rien de plus |
| `InterclubOfficial.checkJson` | pour ceux qu'une vérification de capitaine a rapprochés : nom fédéral, classement, rang mixte, licence |

Le second enrichit le premier. Un adversaire croisé puis vérifié devient une entrée sûre,
proposée dans un menu, qu'on ne retape plus — et dont on connaît le classement, donc l'ordre
qu'il doit tenir. La liste s'enrichit d'elle-même, rencontre après rencontre.

Ce n'est **pas le roster de l'équipe adverse** : un joueur croisé pour la première fois n'y est
pas, et la saisie libre reste donc atteignable dans les deux menus. Le vrai roster viendra de la
fiche d'équipe fédérale (`ic_a=393480`, cf. `docs/squashnet.md`), le jour où son rendu aura pu
être capté.

#### Deux menus, et pourquoi ils existent

Le nom d'un adversaire était un champ de texte, recopié à la main un soir de rencontre sur un
téléphone. « Détry » un mois, « detry » le suivant : le rapprochement fédéral échouait sur un
accent, et le rapport du capitaine déclarait « introuvable » un joueur parfaitement réel. Deux
menus (`GET /api/interclub/opponents`) suppriment la ressaisie : **le club adverse** à la
création d'une rencontre, **ses joueurs** à la composition d'un simple.

La fusion replie la casse, les accents et les espaces — **pas les fautes de frappe** : « Detri »
reste un autre joueur que « Detry ». C'est le menu qui traite la faute de frappe, en rendant la
ressaisie inutile.

Deux règles de fusion qui se voient à l'usage :

- pour un **joueur**, c'est le nom **le plus récent** qui est retenu — il reflète la dernière
  correction faite à la main — et l'identité fédérale **la plus riche** : une vérification qui a
  abouti une fois vaut mieux que trois qui n'ont rien conclu ;
- pour une **équipe**, c'est le **premier** — un nom d'équipe n'est jamais corrigé à la main, il
  est estampillé par l'import du calendrier fédéral, et une variante saisie plus tard (« chaville
  4 ») dégrade l'orthographe officielle au lieu de la corriger.

Le serveur **refuse un capitaine qui ne joue pas dans l'équipe** : c'est presque toujours une
erreur de saisie, et le laisser passer donnerait un destinataire d'alertes qui ne se sent pas
concerné, donc des alertes que personne ne traite.

### Les disponibilités — et le droit de répondre pour un autre

Trois réponses, `yes` / `maybe` / `no`, plus un commentaire libre de 200 caractères. Le
décompte se lit en **simples couverts** (`counts.yes` contre `matchCount`) et non en taux de
réponse : c'est la seule question que le capitaine se pose. Les « incertain » sont dits **à
part** — les compter comme présents ferait taire l'alerte le jour où elle sert.

**Tout le monde voit tout.** Savoir qu'on n'est que trois est ce qui fait répondre le
quatrième ; un écran où chacun ne verrait que sa propre réponse laisserait le capitaine seul
avec le problème.

**N'importe quel membre de l'équipe peut répondre pour un autre**, membre ou joueur sans
compte. Sans ce chemin, l'outil ne sert à rien pour la moitié du roster : les joueurs sans
compte ne verront jamais l'appel, et les membres qui n'ont pas activé les notifications non
plus. `InterclubAvailability.setById` porte **qui a saisi** ; différent du sujet, la ligne
affiche « relayé par … ». Pas de booléen `relayed` en plus : il serait déductible, donc capable
de mentir.

**L'admin passe, rattaché à l'équipe ou non.** Il lit les réponses de toutes les rencontres et
relaie pour n'importe quel joueur du roster — c'est lui qui pose les équipes, et jouer en 2 (ou
nulle part) ne doit pas lui cacher qu'il manque quelqu'un en 1. Le passe-droit ouvre la
**rencontre**, pas l'équipe : le sujet d'une réponse doit toujours en être, et un admin hors
roster n'a donc pas de réponse à lui (l'écran ne lui montre pas « à répondre »).

**Écraser une réponse de première main se confirme.** Si la réponse existante a été posée par
l'intéressé lui-même, le `PUT` répond **409** avec ce qu'elle disait ; l'écran l'affiche et
redemande, et le relais n'aboutit qu'avec `confirmOverride: true`. Le capitaine qui a eu la
personne au téléphone corrige ; personne ne fait disparaître un « non » assumé sans l'avoir vu.
**Le sens inverse est libre** : l'intéressé écrase toujours un relais sans confirmation — c'est
sa réponse.

**Le capitaine doit savoir qui est injoignable**, sinon il relance en aveugle. Le `GET` expose
pour chaque joueur s'il est **atteignable par notification** (au moins une `PushSubscription`),
et l'écran regroupe à part les « sans réponse et sans notification » : c'est sa liste d'appels.
Les joueurs sans compte y tombent d'office.

⚠️ **Injoignable ne veut pas dire exclu de la relance.** La relance part à *tous* les
non-répondants qui ont un compte, poussables ou non : dans ce projet la cloche est le **repli** du
push et non son doublon — le journal est alimenté depuis le transport, pour tous les destinataires
visés. Filtrer sur `reachable` privait les non-poussables de la seule ligne qui leur restait. Ils
demeurent néanmoins dans la liste d'appels : une entrée dans la cloche n'est pas la preuve qu'on
l'a vue.

**Supprimer un compte reste possible.** `setById` est en `ON DELETE SET NULL` (migration 42) et
non en `RESTRICT` : sinon un membre ayant répondu une seule fois devenait indélébile, ce qui
contredisait la promesse « tes données disparaissent avec ton compte ». La ligne d'un auteur
supprimé n'est pas perdue pour autant : `setById IS NULL` s'y lit sans ambiguïté « relais, par
quelqu'un qui n'est plus là » — celle qu'il avait donnée pour lui-même, elle, part avec lui par
cascade.

### Les trois crons

| Cron | Rythme | Ce qu'il fait |
|---|---|---|
| `/api/cron/interclub-standings` | `0 2,6,10,14,18,22 * * *` **Europe/Paris**, via **cron-job.org** | Relit le **classement de poule** et les **feuilles de match officielles** des équipes qui ont joué : à partir de **22 h le soir du match**, puis toutes les 4 h pendant les **5 jours suivants** (dernier passage à 22 h le 5e jour). Hors fenêtre, ne touche pas Postgres. |
| `/api/cron/interclub-availability` | `0 8 * * *` | Ouvre l'appel à **J-10**, relance les non-répondants à **J-3** et envoie le récap au capitaine à J-3, puis rappelle **à J-1** l'heure, le lieu et l'adresse — aux seuls **alignés**, et sans rien demander. Idempotence par `availabilityOpenedAt` / `availabilityRemindedAt` / `eveRemindedAt`, lus **en cascade** : un seul envoi par jour et par rencontre. **Silence total sur une date non confirmée.** |
| `/api/cron/interclub-calendar` | `0 9 * * 1` | Pour chaque équipe ancrée : récupère, compare, met à jour `snCheckedAt`. Alerte capitaine et admins **tant que l'écart n'est pas appliqué**, et **n'écrit aucune rencontre** — l'application reste un geste d'admin. Relit aussi le classement et les feuilles de match, en filet du précédent — c'est lui qui rattrape la saison déjà jouée. |

**Le classement d'après-match passe par cron-job.org**, comme `check-alerts` : le plan Vercel
Hobby refuse au déploiement toute expression plus fréquente qu'une fois par jour (cf.
`docs/neon-keep-alive.md`). Réglages du job :

| Champ | Valeur |
|---|---|
| URL | `https://squash-yvette.vercel.app/api/cron/interclub-standings` |
| Méthode | `GET` |
| En-tête | `Authorization: Bearer <CRON_SECRET>` |
| Expression cron | `0 2,6,10,14,18,22 * * *` |
| Fuseau | `Europe/Paris` ⚠️ (sinon UTC, et le passage de 22 h tombe à minuit l'été) |

Le cron passe tous les jours, match ou pas ; c'est la route qui décide s'il y a quelque chose à
relire (`standingsWindowOpen`). Reporter une rencontre ne demande donc rien de ce côté-là. La
porte qui le décide vit dans le Data Cache, invalidée par `interclubChanged()` : un passage sans
fenêtre ouverte ne réveille pas Neon, et ne laisse **aucune trace** dans le suivi des crons de
`/admin` — la ligne `interclub-standings` date du dernier passage utile. Une date
**prévisionnelle** n'ouvre pas de fenêtre, sauf si un score y a été saisi.

Coût Neon : en saison, les fenêtres des deux équipes se chevauchent presque sans trou, donc
jusqu'à ~5 réveils par jour (le passage de 18 h tombe dans la fenêtre du keep-alive), soit
**~3 CU-h/mois** sur les 100 du plan gratuit. Rien hors saison.

### Le palmarès des joueurs : sur la feuille officielle

Les **statistiques des joueurs** (`/api/interclub/stats`, `interclub-stats.ts`) se calculent sur
les **feuilles de match publiées par la ligue** (`Interclub.snSheetJson`, migration `69_`), et
plus sur nos relevés : une soirée que personne n'a marquée dans l'appli compte quand même.

- **Relues avec le classement**, par les trois mêmes déclencheurs : le cron d'après-match, le
  contrôle du lundi et le bouton « Relire le classement » de l'admin (`interclub-sheets.ts`).
  Sont relues les rencontres en fenêtre d'après-match, et les rencontres passées dont la feuille
  manque, est incomplète ou dont notre côté n'a pas été reconnu. Une feuille complète hors
  fenêtre ne l'est plus.
- **Notre côté** (« A » ou « B ») est reconnu au sigle, puis aux noms de notre fiche d'équipe
  (`ourSide`), et rangé dans `snSheetSide`. Inconnu, la feuille ne compte pas.
- **Qui est qui** : nom fédéral → licence (notre fiche d'équipe) → joueur de l'appli
  (`snLicence`), puis à défaut par nom. Un joueur non relié reste compté sous son nom fédéral.
- Une feuille **vide** n'écrase jamais une feuille lue. L'écran dit la date de la dernière
  relecture et le nombre de rencontres jouées **sans feuille officielle** (rencontres saisies à
  la main comprises : elles n'en auront jamais).

`snCheckedAt` existe pour répondre à la question que le silence ne tranche pas : « le calendrier
n'a pas bougé », ou « on n'a pas regardé » ?

**Ce que fait l'empreinte, et ce qu'elle ne fait pas.** `snCalendarHash` évite de reconstruire
l'écart complet quand rien n'a bougé — c'est tout. Elle **n'est pas** réécrite par le cron, donc
un écart non appliqué est **re-signalé chaque lundi**, et c'est voulu : la faire taire dès la
première lecture laisserait un report enterré dans une notification que personne n'a ouverte. La
relance s'arrête à l'application, ce qui est le moment où elle doit s'arrêter.

**Une journée retirée du calendrier est signalée, jamais supprimée** (`diffCalendar().toDelete`).
Sans ce quatrième volet, une rencontre annulée par la ligue restait en base et le cron quotidien
ouvrait consciencieusement son appel de disponibilité pour une soirée qui n'existe plus. On ne la
supprime pas d'office : elle porte peut-être déjà une composition et des réponses, et « plus rien
n'est publié » peut n'être qu'un scraping qui a cassé.

**Une rencontre déjà commencée ne se déplace plus**, ni par le `PATCH` (409) ni par l'import (la
date est gardée, le reste s'applique, et l'écran le dit). Le chemin automatique — celui que
personne ne regarde — ne doit pas être moins prudent que le chemin humain.

**Les deux angles morts de la date prévisionnelle.** La détection repose sur une signature :
plusieurs *journées* le même jour. Donc deux vraies journées un même soir (un rattrapage) passent
pour prévisionnelles et sont coupées de toute notification ; et une *seule* journée non planifiée
ne produit aucune signature, donc passe pour ferme. Dans les deux cas le rattrapage est le même,
et c'est pour lui que `dateConfirmed` est modifiable à la main plutôt que déduit à chaque
lecture : `PATCH /api/interclub/{id}`.

### Trois populations à ne pas confondre

`InterclubFollow` est un abonnement au **score**, ouvert à tous. L'appel de disponibilité
s'adresse aux **membres de l'équipe** (`User.teamId`). Le récapitulatif et les alertes de
calendrier s'adressent au **capitaine seul**. Envoyer une convocation à des spectateurs, ou
« il manque du monde » à toute l'équipe, viderait les deux de leur sens — d'où `sendTo()` dans
`interclub-notify.ts`, qui vise des destinataires nommés et non `followersFor`.

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

**Les derniers jours restent en haut, et la carte ouvre la fiche** (demande du club,
2026-10-16). Le panneau garde, sous « Ces derniers jours », les rencontres des quatre jours
précédents (`RECENT_FIXTURE_DAYS`), terminées ou non, pour finir d'en saisir les scores sans les
chercher dans le calendrier. Elles s'y résument en une ligne — date, état, score — et toute
carte s'ouvre d'un appui. Le **sondage**, lui, ne regarde que ce qui peut encore bouger : les
rencontres du jour, et celle de la veille seulement si un simple y est en cours de marquage
(soirée qui déborde après minuit). Une rencontre d'hier restée « en cours » faute de deux simples
saisis ne déclenche plus le sondage à 10 s. Au-delà de quatre jours, une rencontre commencée et
jamais finie s'affiche **« Non complétée »** (`fixtureDisplayStatus`) ; une date passée sans
aucun score, **« À saisir »**.

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

Le formulaire de saisie a posteriori, lui, n'écrit pas la suite d'un journal : il CORRIGE des
jeux déjà enregistrés. Ce qu'il envoie ne peut donc pas servir de référence — le comparer à la
base refuserait exactement ce qu'on lui demande, corriger un score. Il joint `knownGames`, le
score TEL QU'IL L'A OUVERT ; c'est ce cliché que la garde confronte à la base, et l'ancien client
qui ne l'envoie pas retombe sur la protection par préfixe. Les jeux sont relus `ORDER BY number`
des deux côtés : la comparaison se fait position par position, et un ordre laissé au hasard
inventerait des écarts.

---

## Carte du code

**Moteur pur** (aucune dépendance à Prisma, testable seul)
- `src/lib/interclub.ts` — règles du jeu, replay d'événements, couleurs de maillot, paliers
  d'abonnement. Un jeu se gagne à 11 points avec 2 d'écart ; **2 min entre les jeux** (règles
  WSF du 1ᵉʳ septembre 2025, qui alignent l'amateur sur la PSA). Porte aussi `lineupComplete` —
  les deux joueurs d'un simple sont-ils désignés ? — partagée par le client et les trois routes
  d'écriture (claim, live, PATCH).
- `src/lib/interclub-order.ts` — l'**ordre des simples** (classement puis rang mixte) :
  `classementPower`, `isNC`, `lineupOrderConflict`, `parseClassementInput`, `parseRangMInput`.
  Cf. « Ordre des simples : classement, puis rang mixte »
  ci-dessus.
- `src/lib/interclub-opponents.ts` — ce qu'on sait des joueurs **d'en face** : `mergeOpponents`,
  `opponentTeams`, `estDesigne`, et `awayLineupConflict` — l'ordre des simples ADVERSES, qui
  délègue à `lineupOrderConflict` plutôt que de la recopier. Pur, donc employé **par l'écran**
  autant que par les routes : ce que le menu grise, le serveur le refuse, et réciproquement
- `src/lib/interclub-duree.ts` — la **durée d'un simple** : quelles heures `PUT …/live` pose
  (`liveMatchTimes`, `liveGameTimes`), ce qu'une correction conserve (`correctedGameTimes`), et
  ce que l'écran en affiche (`matchDurationMs`, `fixtureDurationMs`, `formatDuration`). Cf. « La
  durée d'un simple »

**Côté base**
- `src/lib/interclub-db.ts` — sérialisation, score de rencontre, statut déduit, péremption de la
  prise, et `staleGamesReason` : la **garde de fraîcheur des jeux, écrite une seule fois** et
  appliquée par les deux routes d'écriture. Elle a vécu en double, et les deux copies avaient
  divergé — le `PATCH` n'appliquait qu'une moitié de ce que ce document décrivait. Deux
  exemplaires d'une règle finissent toujours par ne plus dire la même chose.
- `src/lib/interclub-opponents-db.ts` — les lectures qu'attend le module pur ci-dessus :
  `loadKnownOpponents` (les adversaires connus d'une équipe) et `findAwayOrderConflict` (le
  pendant de `findOrderConflict` pour le camp adverse, lu dans la transaction qui écrit)
- `src/lib/interclub-roster.ts` — **qui peut être aligné** (`teamRoster`, `resolveHomePick`, `findAlignmentClash`, `rankingRefusal`), l'effectif de TOUTES les équipes pour l'écran d'admin (`allTeamMembers`, `allTeamGuests`) et, depuis l'ordre par classement, `findOrderConflict`
- `src/lib/squashnet/refresh.ts` — le **rapprochement fédéral** des DEUX populations en une passe (`refreshRankings`), et à la demande d'un joueur sans compte (`matchGuestRanking`) ou d'un membre dont on vient de corriger le nom de recherche (`refreshMemberRanking`)
- `src/lib/interclub-stats.ts` — le **palmarès des joueurs**, calculé sur les feuilles officielles (pur), avec la liste des matchs de chacun ; `src/lib/interclub-sheets.ts` — lesquelles relire, et leur écriture
- `src/lib/squashnet/pool.ts` — les **rencontres d'une poule**, lues dans le fragment du classement (pur) ; `src/lib/squashnet/player.ts` — la **fiche joueur** fédérale (pur)
- `src/lib/interclub-pool-db.ts` — les caches `SquashnetPool` et `SquashnetPlayer` ; `src/lib/interclub-team-sheet.ts` — la **fiche d'une équipe** et celle d'un joueur, assemblées (pur) ; `src/lib/interclub-team-sheet-db.ts` — leur lecture et leur relecture à la demande
- `src/lib/interclub-score.ts` — un score de simple lu pour l'affichage : retourné, totalisé (pur)
- `src/lib/interclub-gate.ts` — le **cache** du direct
- `src/lib/interclub-access.ts` — le **contrôle d'accès** (flag + session)
- `src/lib/squashnet/calendar.ts` — le **calendrier fédéral** : parsing pur
  (`parseTeamCalendar`, `ownFixtures`), écart (`diffCalendar`, rapproché par JOURNÉE) et
  empreinte (`calendarFingerprint`). Une seule définition de « ce qui a changé », partagée par
  la prévisualisation, l'application et le contrôle hebdomadaire — pour que l'alerte et l'écran
  ne puissent pas se contredire
- `src/lib/interclub-availability.ts` — les trois réponses, le décompte en **simples couverts**
  (`tally`, `isShortHanded`), la règle de confirmation d'un relais (`needsOverrideConfirm`) et
  les fenêtres d'appel / relance (`dueAction`)
- `src/lib/interclub-notify.ts` — ciblage des abonnés et rédaction des notifications, dont
  l'appel de disponibilité, la relance des seuls non-répondants, le report de date, le récap au
  capitaine et l'alerte de dérive du calendrier
- `src/lib/http-tx.ts` — transaction Serializable partagée (sert aussi au tournoi et au tricount)

**Routes**
| Route | Ce qu'elle fait |
|---|---|
| `GET/POST /api/interclub` | Liste des rencontres · création (+ les N simples d'un coup) |
| `GET/PATCH/DELETE /api/interclub/{id}` | Détail (avec le roster de l'équipe) · correction de la date, l'heure, le lieu, l'adversaire · suppression |
| `GET/PUT …/{id}/availability` | Les réponses de l'équipe · poser la sienne ou celle d'un autre (409 sur une réponse de première main). Les deux verbes rendent la **même forme**, `me` compris — l'écran remplace son état par ce corps |
| `PATCH /api/interclub/{id}/matches/{mid}` | Composition, couleurs, jeux (saisie a posteriori) |
| `PUT …/matches/{mid}/live` | Instantané du marquage en direct — **chemin chaud** |
| `POST/DELETE …/matches/{mid}/claim` | Prendre / relâcher le marquage |
| `GET /api/interclub/live` | État des rencontres du jour (servi par le Data Cache) |
| `GET/PUT /api/interclub/follows` | Mes abonnements |
| `GET /api/directory` | Annuaire : membres opt-in ET joueurs sans compte (`kind`), avec équipe et classement |
| `GET/POST /api/admin/interclub-teams` | Équipes, membres et joueurs sans compte, dont leur classement et leur rang mixte ; rapprochement squashnet à l'ajout et à la demande (**admin**) |
| `POST /api/admin/interclub-teams` (actions `set_captain`, `set_squashnet_event`) | Capitaine de l'équipe · ancrage fédéral — **épreuve, poule ET équipe**, les trois ensemble ou aucun (**admin**) |
| `POST /api/admin/interclub-calendar` | Import du calendrier : `preview` puis `apply` (**admin**) |
| `GET /api/cron/interclub-availability` | Appel J-10, relance J-3, récap au capitaine |
| `GET /api/captain` | Les rencontres dont ce capitaine répond, et où en est leur vérification |
| `GET /api/captain/check/{id}` | Relit le dernier rapport — sans toucher à squashnet |
| `POST /api/captain/check/{id}` | REFAIT la vérification (jusqu'à 8 recherches fédérales) |
| `GET /api/cron/interclub-calendar` | Contrôle hebdomadaire de dérive — alerte, n'écrit rien |
| `GET /api/cron/interclub-standings` | Relecture du classement de poule — et de ses rencontres — après chaque rencontre (cron externe) |
| `GET/POST /api/interclub/poule/equipe?snTeamId=` | Fiche d'une équipe de nos poules · la même après relecture de ce qui a vieilli (≤ 2 requêtes fédérales) |
| `GET/POST /api/interclub/poule/joueur?regiid=` | Matchs d'un joueur de nos poules · les mêmes après relecture de sa fiche fédérale (≤ 1 requête) |
| `POST /api/admin/members` (action `set_clt_override`) | Correction admin du classement ET du rang mixte d'un membre (**admin**) |
| `POST /api/admin/members` (action `set_squashnet_name`) | Nom sous lequel chercher un membre sur squashnet, puis rapprochement immédiat (**admin**) |
| `POST /api/admin/members` (action `rematch_squashnet`) | Retente le rapprochement d'un membre, sans rien modifier (**admin**) |
| `GET /api/notifications` | La cloche (pas de flag : elle sert à toute l'appli) |

**Composants** — `Interclub.tsx` (orchestration), `InterclubScorer.tsx` (marquage),
`InterclubLive.tsx` (bandeau direct), `InterclubFollow.tsx` (abonnement),
`InterclubAvailability.tsx` (le bloc « qui peut venir ? » d'une rencontre),
`InterclubTeamSheet.tsx` (la fiche d'une équipe de la poule, et les matchs d'un joueur du club).

**Pas de composant « calendrier ».** La liste des rencontres **est** déjà cette liste : elle
porte désormais la journée, l'heure, le lieu et la mention « prévisionnelle », et elle range les
rencontres à venir en tête. En créer une seconde des mêmes objets recréerait à l'écran la double
vérité que le modèle évite.

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
- **`Interclub.tsx` fait ~2300 lignes** et concentre cinq écrans, le classement de poule
  s'étant ajouté avec le calendrier. Le découpage n'est plus une éventualité. Découpage à
  envisager si un
  cinquième s'ajoute.
- **Hors périmètre du premier lot de disponibilités** : la convocation officielle (le capitaine
  retient N joueurs, chacun reçoit la sienne), l'export ICS / l'abonnement webcal, l'application
  automatique des dérives de calendrier, et le covoiturage.
