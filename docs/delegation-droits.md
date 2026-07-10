# 🔐 Idée 4 — Délégation temporaire de droits (notes de cadrage)

Statut : **🚧 V1 implémentée** sur la branche `delegation`, **gated `FEATURE_DELEGATION`
(OFF par défaut)** — invisible tant que le flag n'est pas activé. Ce fichier capture la
discussion de cadrage du 2026-07-08 (toujours valable) + l'état du code au 2026-07-08.
Contexte général : voir idée **4** dans [`idees-developpement.md`](./idees-developpement.md).

## Livré (V1, branche `delegation`)

- **Schéma** : `model Delegation` (`prisma/migrations/11_delegation`) + `Booking.actingUserId`
  (pas de FK, comme `PlanningSnapshot.updatedById`). Diff vérifié hors-ligne
  (`prisma migrate diff --from-schema-datamodel ... --to-schema-datamodel ...`) identique à
  ce que Prisma aurait généré — aucune connexion DB nécessaire pour l'écrire/vérifier.
- **`src/lib/session.ts`** : logique de refresh/claim extraite en `resolveResaToken()`
  (partagée), exposant `getResaTokenForUser(userId)` — récupère/rafraîchit le jeton
  ResaMania d'un AUTRE user par son id, sans dépendre de son cookie.
- **`src/lib/delegation.ts`** (+ `delegation-shared.ts` pour les constantes côté client) :
  `getActiveOutgoingDelegations`, `getActiveIncomingDelegations`, `findActiveDelegation`,
  et surtout `resolveActingContext(session, onBehalfOf, message)` — point d'entrée unique
  utilisé par book/cancel-slot/bookings pour résoudre soit sa propre session, soit celle
  du délégant si `onBehalfOf` est fourni et couvert par une délégation active.
- **API** : `GET/POST /api/delegations` (créer — `delegateIds[]`, une délégation par membre
  choisi ; si un membre avait déjà une délégation active de ma part, elle est renouvelée.
  `extend: true` = prolongation **additive** : échéance actuelle + durée, et non maintenant
  + durée), `DELETE /api/delegations/{id}` (révoquer, délégant uniquement).
- **`onBehalfOf`** branché dans `POST /api/book`, `POST /api/cancel-slot`,
  `DELETE /api/bookings/{id}` : la règle « un seul terrain par horaire » et le
  `Booking.userId` portent sur le **délégant** (propriétaire réel), `actingUserId` trace le
  délégué.
- **UI** : Réglages → section « Déléguer mes droits » (choix d'un ou plusieurs membres via
  `/api/directory`, durée 24h/3j/5j, révocation individuelle par délégué). En-tête : sélecteur « Pour moi / Pour {délégant} » si une
  délégation entrante est active, poussé dans les 4 appels de réservation/annulation.
- **Cron `keep-alive-delegations`** (`vercel.json`, quotidien 5h) : rafraîchit le jeton de
  chaque délégant ayant une délégation active via `getResaTokenForUser`, scope limité aux
  délégations actives (pas tout le club).
- Vérifié : `tsc --noEmit`, `next lint`, `next build` tous verts (sans `prisma migrate`
  ni `npm run build`, `.env` local pointant vers la prod).

## Pas fait / ouvert avant d'activer le flag en prod

- **Note de confidentialité (RGPD, contrainte 4)** : pas encore mise à jour — `actingUserId`
  et le fait qu'un membre puisse agir pour un autre sont une nouvelle finalité à
  documenter, comme fait pour l'annuaire (idée 6).
- **Pas testé en conditions réelles** (aucune requête faite contre la prod pendant ce
  chantier) — à faire via un déploiement preview avant d'activer `FEATURE_DELEGATION`.
- Historique des délégations passées : non affiché (seule la délégation active l'est).
- Le filtre « pas moi-même » dans le picker de délégué (Réglages) n'est fait que
  côté serveur (400 si on se choisit soi-même) — pas de filtre client dans la liste.

## Besoin

Un utilisateur (le **délégant**) délègue momentanément ses droits de réservation à un
autre membre (le **délégué**) — ex. gérer les réservations d'une soirée à sa place
pendant qu'il est indisponible (vacances, pas de téléphone…).

Contrainte de fond (rappel `idees-developpement.md`) : **jamais de partage du mot de
passe ResaMania**. La réservation reste techniquement faite avec le **jeton du
délégant** (c'est son compte ResaMania qui réserve), mais l'**action** est déclenchée
par le délégué — d'où le besoin d'un mécanisme de délégation applicative, avec
traçabilité de qui a agi pour qui.

## Modèle de données proposé

```prisma
model Delegation {
  id          String    @id @default(cuid())
  delegator   User      @relation("DelegationGiven", fields: [delegatorId], references: [id], onDelete: Cascade)
  delegatorId String
  delegate    User      @relation("DelegationReceived", fields: [delegateId], references: [id], onDelete: Cascade)
  delegateId  String
  scope       String    // "book" | "book_cancel" — v1 : pas plus large
  expiresAt   DateTime  // borne dure (ex. 24h à 5j) — limite le rayon si compromis
  revokedAt   DateTime?
  createdAt   DateTime  @default(now())

  @@index([delegateId, expiresAt])
  @@index([delegatorId])
}
```

Sur `Booking`, ajouter :
```prisma
actingUserId String? // qui a physiquement déclenché l'action, si différent de userId
```
`Booking.userId` reste le **délégant** (propriétaire réel de la résa ResaMania) ;
`actingUserId` = le **délégué**, pour l'audit / l'affichage (« réservé par X pour le
compte de Y »).

## Mécanique d'accès au jeton

Aujourd'hui (`src/lib/session.ts`), `getSession(sid)` résout le jeton ResaMania **à
partir du cookie** du user courant, et rafraîchit l'`accessToken` (~1h de vie, cf.
`client.ts` `exchangeToken`/`ensureFresh`) via le `refreshToken` (rotatif, stocké
chiffré dans `Session.refreshTokenEnc`) quand nécessaire, avec un verrou
(`updateMany` + `REFRESH_CLAIM_MS`) pour sérialiser les requêtes concurrentes.

Pour la délégation, il faut une fonction sœur, ex. `getResaTokenForUser(delegatorId)` :
- retrouve la **session la plus récente encore valide** du délégant
  (`prisma.session.findFirst({ where: { userId: delegatorId, refreshTokenEnc: { not: null }, expiresAt: { gt: now } }, orderBy: { createdAt: "desc" } })`) ;
- lui applique **la même logique de refresh/claim** que `getSession`, mais keyée par
  l'`id` de cette session plutôt que par le cookie du délégué ;
- ne dépend donc **pas** du cookie ni de l'activité du délégant : c'est le serveur qui
  rafraîchit, déclenché par la requête du délégué.

`POST /api/book` (et `cancel-slot`/`bookings/[id]`) accepterait un `onBehalfOf?: userId`
optionnel : si présent, vérifie qu'une `Delegation` active (scope + non expirée + non
révoquée) existe `delegatorId → session.userId` (le user connecté = délégué), utilise
le jeton du délégant, écrit `Booking.userId = delegatorId`,
`actingUserId = session.userId`.

## Le problème du token qui dort (discussion du 2026-07-08)

**Question posée** : et si personne (ni délégant ni délégué) ne fait de requête
pendant plusieurs jours — le refresh a-t-il seulement une chance de se déclencher ?

**Constat** : `ensureFresh` ne tourne que *dans* `getSession()`, donc uniquement
quand une requête HTTP arrive pour ce `sid`. En usage normal ça ne pose jamais
problème (si un membre n'ouvre pas l'app, ça ne gêne que lui). Mais avec la
délégation, on compte sur le token d'un tiers qui, par hypothèse, ne va **justement
pas** toucher son téléphone pendant la fenêtre déléguée — et si le délégué non plus
ne réserve rien pendant 2-3 jours d'affilée, rien ne rafraîchit la session du
délégant entre-temps. Inconnue non levée : on ignore si le `refresh_token` ResaMania
a une règle d'expiration **par inactivité** côté OAuth (au-delà de sa rotation) — les
"~30 jours" observés empiriquement s'expliquent peut-être juste par le fait qu'en
usage normal quelqu'un rouvre l'app assez souvent pour l'entretenir sans qu'on le
remarque.

**Solution retenue** : un cron de maintien proactif, sur le même principe que les
crons quotidiens déjà en place (`vercel.json` : `warm-planning` à 6h, `check-alerts`
à 7h — contrainte Vercel Hobby = cron **quotidien**).

**Cron `keep-alive-delegations`** (quotidien, ex. 5h) :
1. Sélectionne les `Session` dont le `userId` est **délégant d'une `Delegation`
   encore active** (pas toutes les sessions du club — inutile de solliciter
   ResaMania pour des membres qui ne délèguent rien ; contrainte 1 : rester discret
   sur une API rétro-ingénierée).
2. Pour chacune, appelle `ensureFresh()` — même verrou `updateMany`/claim que
   `getSession()`, pour éviter une course si le délégué réserve au même moment.
3. Persiste le nouveau couple access/refresh token (rotation), comme le fait déjà
   `getSession`.

Effet : tant qu'une délégation est active, son token est re-rafraîchi chaque jour
automatiquement, indépendamment de l'activité du délégant ou du délégué — couvre
large une fenêtre de 24h comme de 5 jours.

**Limite non couvrable** : si le délégant se déconnecte ailleurs, change son mot de
passe, ou que ResaMania révoque son autorisation pendant la fenêtre, le refresh
échouera un matin et la délégation s'arrêtera net. Prévoir un message d'erreur clair
à ce moment-là côté délégué (« la délégation n'est plus valide, la session de X a
expiré ») plutôt qu'un échec silencieux.

## Flux UI proposé

- **Réglages → « Déléguer mes droits »** : le délégant choisit un membre (annuaire,
  idée 6, déjà livré), une durée (préréglages : ce soir / 24h / 5 jours / custom), un
  scope. **Seul le délégant peut créer** la délégation (jamais une demande du
  délégué — évite l'ingénierie sociale/le forcing).
- Le délégant peut **révoquer à tout moment** (bouton, `revokedAt`).
- Côté délégué : si délégation active entrante, un sélecteur avant de réserver
  (« Pour moi » / « Pour <nom du délégant> »).
- ~~V1 : une seule délégation active à la fois par délégant~~ **Évolution 07/2026 :
  plusieurs délégués simultanés** (liste à cocher dans Réglages, une révocation par
  délégué). Reste : au plus une délégation active par couple délégant/délégué.

## Bornes V1 volontaires (pour rester cadré, pas usine à gaz)

- Scope = `book`/`cancel` seulement (pas présence, pas tricount, pas profil).
- TTL dur et court par défaut (24h à 5j max) plutôt qu'une délégation permanente.
- Au plus une délégation active par couple délégant/délégué (multi-délégués possible
  depuis 07/2026, borné à 20 par requête).
- **Plafond de session** (07/2026) : une délégation ne peut pas fonctionner au-delà de
  `Session.expiresAt` du délégant (30 j non glissants après sa connexion — le cron
  keep-alive rafraîchit le jeton ResaMania mais ne prolonge pas la session). Le POST
  **refuse** (409) toute échéance qui dépasse, avec invitation à se reconnecter ; l'UI
  affiche la date de validité de la connexion dans la section délégation.
- Cron de maintien scopé **uniquement** aux délégations actives (pas toutes les
  sessions du club).
- Note de confidentialité (RGPD, contrainte 4) à compléter : nouvelle finalité —
  `actingUserId` exposé sur les résas concernées, qui délègue à qui, pendant
  combien de temps.

## Points ouverts avant de coder

- Confirmer la durée par défaut/max souhaitée (24h ? 5 jours ? plus ?).
- Vérifier en conditions réelles si le `refresh_token` ResaMania meurt réellement par
  inactivité (pas juste une hypothèse) — pourrait simplifier ou complexifier le
  besoin du cron de maintien.
- Décider de l'affichage de l'historique de délégation (qui a délégué à qui, quand)
  — utile pour la traçabilité mais nouvelle surface UI.
- Extraire proprement la logique de refresh/claim de `getSession()` dans un helper
  partagé, pour éviter la duplication entre le chemin cookie et le chemin
  `getResaTokenForUser`/cron.
