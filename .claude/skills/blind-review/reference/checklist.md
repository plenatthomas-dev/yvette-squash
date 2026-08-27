# Classes de défauts qui comptent dans ce dépôt

Liste de contrôle du skill `blind-review`. Ce sont des **règles du projet**, énoncées dans ses
propres documents — pas l'intention d'une fonctionnalité particulière. Les consulter ne rompt
donc pas l'aveuglement.

Ne pas dérouler la liste mécaniquement : elle sert à savoir où regarder, pas à produire une
constatation par ligne.

---

## 1. Ordre des gardes dans une route API

Motif canonique, dans cet ordre exact :

1. `getFeatures()` → **404** si la fonction est coupée ;
2. `getSession(req.cookies.get("sid")?.value)` → **401** ;
3. `appBlockForUserId` → 503 le cas échéant ;
4. corps `await req.json().catch(() => ({}))`, puis validation à la main (pas de zod) ;
5. travail, puis réponse JSON.

À vérifier : une route qui lit la base **avant** de vérifier le flag ou la session ; un `403`
là où le motif veut un `404` (un flag coupé ne doit pas révéler que la route existe) ; une
route d'admin sans `requireAdmin`.

## 2. Exposition de données

- L'appli est **entièrement authentifiée**. Toute route servant des données de membres sans
  contrôle de session est un défaut, même en lecture.
- `Cache-Control: public` / `s-maxage` sur une réponse authentifiée : un cache **partagé**
  indexe sur l'URL, pas sur le cookie. La réponse d'un membre serait servie à n'importe qui.
- Ce qui ne doit jamais sortir : e-mail, `contactId`, numéro de licence, jetons ResaMania.
- Une valeur secrète dans un message d'erreur, un log, ou une URL.

## 3. Budget — la contrainte la plus structurante

`PRODUCT.md` : rester dans les paliers gratuits. **Neon** suspend son compute après 5 min
d'inactivité, quota 100 CU-h/mois ; **Vercel Hobby** ne permet qu'un cron par jour (une
expression `*/4` fait échouer le build).

À vérifier :

- une requête Postgres sur un **chemin chaud** (chargement de planning, polling, rendu de
  liste) qui pourrait être évitée, mise en cache, ou groupée ;
- un `setInterval` de polling dont la fréquence ne dépend pas de l'état (il devrait s'arrêter
  quand il n'y a rien à suivre, et quand l'onglet n'est pas visible) ;
- une requête **par élément** dans une boucle là où un `groupBy` ou un `findMany` suffirait ;
- un coût qui croît avec le **nombre d'utilisateurs** plutôt qu'avec l'activité réelle.

Le motif de référence est `src/lib/alerts-gate.ts` : Data Cache + `revalidateTag`, avec repli
sur lecture directe en cas de panne du cache.

## 4. Concurrence

Plusieurs personnes écrivent en même temps un soir de rencontre ou de tournoi.

- Une lecture suivie d'une écriture sur la même ligne, hors transaction : que se passe-t-il si
  deux requêtes s'entrelacent ? La valeur écrite peut-elle être calculée sur un état périmé ?
- Une transaction `Serializable` sans reprise sur `P2034` (motif :
  `src/app/api/tournaments/[id]/matches/[mid]/route.ts`).
- Un `upsert` ou un compteur qui suppose l'absence de course.
- Un état stocké qui peut diverger de l'état déduit : y a-t-il une auto-cicatrisation, et
  l'affichage lit-il le stocké ou le déduit ?

## 5. Schéma et migrations

- `prisma/migrations/README.md` : préfixe à **deux chiffres obligatoire** (`34_sujet`). Un tri
  `localeCompare` a déjà causé deux incidents de production.
- Le SQL de la migration correspond-il au `schema.prisma` ? (vérifiable sans base :
  `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`,
  puis comparaison des tables, index et clés étrangères).
- Le schéma ne contient **aucun `enum`** : les états sont des `String` avec les valeurs en
  commentaire. Une nouvelle valeur d'état est-elle validée quelque part ?
- `onDelete` : `Cascade` efface-t-il de l'historique qu'on voulait garder ? `Restrict`
  bloque-t-il une suppression légitime ?
- Les migrations s'appliquent **automatiquement à chaque build**, Preview comprise.

## 6. Notifications

- `pushToAll` arrose tous les abonnés : est-ce vraiment voulu ici ?
- Volume : combien de notifications un abonné reçoit-il par soirée dans le pire cas ?
- `tag` : deux notifications de même tag se remplacent. **Sans `renotify`, le remplacement est
  SILENCIEUX** (ni son ni vibration) — une série partageant un tag ne signalerait que la
  première.
- Idempotence : un rejeu (retry de transaction, double soumission) peut-il notifier deux fois ?
- Un envoi qui échoue peut-il faire échouer l'action de l'utilisateur ? Il ne devrait pas.

## 7. Règles de `DESIGN.md`

- **Vert actionnable** : le vert ne peint que ce qui est actionnable. Un état peint en vert est
  un défaut. (Un grand aplat coloré est acceptable s'il *est* un bouton.)
- **Paire complète** : une couleur hors thème doit fixer fond **et** encre, avec un contraste
  suffisant, dans les trois thèmes (clair, sombre, rose).
- **Fond toujours plus sombre** que les cartes.
- Piège connu : Pico redéfinit `--pico-color` **à l'intérieur** des `<button>`. Un
  `color: var(--pico-color)` sur un bouton à fond de carte donne du texte invisible.
- Micro-typographie sous 0.75rem : doit être un nombre, ou porter un `title` / `aria-label` /
  `sr-only`.

## 8. Tests

- Les tests couvrent-ils les **garanties affirmées**, ou seulement le chemin heureux ?
- Un test qui passerait même si l'implémentation était fausse (assertion trop lâche,
  `toBeDefined` là où il faut une valeur).
- Une garantie chiffrée affirmée en commentaire (une borne, un pire cas) est-elle **calculée**
  par un test, ou seulement écrite ?
- Motif canonique des tests de route : `vi.hoisted()` + `vi.mock` de `features-server`,
  `session`, `db` ; les deux premiers cas sont « 404 si désactivé » et « 401 si non
  authentifié ».
- Le mock d'une route ne doit pas cacher un appel réel non couvert (un module importé par la
  route et non mocké, dont l'échec serait silencieux).

## 9. Client

- Une action qui bloque sur le réseau là où elle pourrait rester locale.
- Un état local qui diverge du serveur sans moyen de se recaler.
- `localStorage` sans `try/catch` (quota, mode privé, stockage refusé).
- Un `useEffect` dont les dépendances mentent (valeur capturée obsolète).
- Une validation faite côté client mais **pas** côté serveur — le serveur fait foi.
