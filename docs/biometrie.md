# 🔐 Connexion biométrique (passkeys / WebAuthn)

Connexion en un geste par **Face ID / Touch ID / empreinte**, sans mot de passe à saisir.
Repose sur les **passkeys** (WebAuthn, `@simplewebauthn` v13). Statut : **implémentée sur
`feature/biometrie`, gated `FEATURE_BIOMETRY` (OFF par défaut en prod, ON en recette)**.

Le secret biométrique ne quitte jamais l'appareil : l'OS (Secure Enclave / TEE) garde la clé
privée, le serveur ne stocke qu'une **clé publique** et un compteur anti-rejeu. On ne voit
jamais l'empreinte ni le visage du membre.

## Le flag `biometry` (indépendant de `emailLogin`)

Nouvelle clé de feature flag, **découplée de la connexion « email seul »** : la biométrie se
pilote toute seule.

- **Env** : `NEXT_PUBLIC_FEATURE_BIOMETRY` (`src/lib/features.ts`, `ENV_FEATURES`). Inliné au
  build, fail-safe **OFF** si absent → invisible en prod tant qu'on ne l'active pas.
  Recette : `=1` dans l'env **Preview** de Vercel. Cf. [`flux-branches.md`](./flux-branches.md).
- **Admin** : apparaît automatiquement dans le panneau « Fonctions de l'appli »
  (`FeatureFlagsPanel`, itère `FEATURE_KEYS`) — Auto / Forcée active / Forcée coupée, à chaud
  (~15 s de propagation, sans redéploiement).
- **Pourquoi découpler d'`emailLogin`** : la biométrie marche **aussi pour les comptes
  ResaMania** (la connexion par passkey restaure leur session ResaMania via le refresh token,
  cf. « échelle de session »), elle n'a donc rien à voir avec la connexion e-mail. Avant, tout
  le périmètre passkey était gated sur `emailLogin` — historique, corrigé.

Toutes les cérémonies/écrans passkey lisent `biometry`. **Exception volontaire** : la
**suppression** d'un passkey (`DELETE`) reste ouverte quel que soit le flag — on ne piège
jamais un membre avec un appareil perdu qu'il ne pourrait plus retirer.

## Enrôlement (activer la biométrie)

1. `POST /api/auth/webauthn/register/options` — gated `biometry` + session requise. Renvoie les
   options WebAuthn (`residentKey: "required"` → passkey **découvrable/usernameless**,
   `authenticatorAttachment: "platform"`, `userVerification: "required"`) et pose le **défi**
   dans un cookie chiffré à usage unique.
2. `POST /api/auth/webauthn/register/verify` — vérifie l'attestation, crée la ligne `Passkey` :
   - `deviceLabel` : donné par le client, sinon **déduit du User-Agent** (`deviceLabelFromUA`,
     ex. « iPhone · Safari ») ;
   - `backedUp` / `deviceType` : état de **sauvegarde** renvoyé par la lib
     (`credentialBackedUp`, `credentialDeviceType`) — cf. « conscience de sauvegarde » ;
   - idempotent : un credential déjà enrôlé (violation d'unicité) renvoie quand même 200.

**Migration** : `prisma/migrations/10_passkey_backup/migration.sql` ajoute `backedUp` (BOOLEAN)
et `deviceType` (TEXT) à `Passkey`, en `ADD COLUMN IF NOT EXISTS` (idempotent).

## Connexion (l'échelle de session)

`POST /api/auth/webauthn/auth/options` ne passe **pas** d'`allowCredentials` : le passkey est
découvrable, l'appareil propose directement le bon compte (pas d'e-mail à taper).

`POST /api/auth/webauthn/auth/verify` vérifie l'assertion puis ouvre **la meilleure session
possible** pour ce compte, dans l'ordre :

1. **ResaMania restaurée** (`createResaSessionFromUser` — refresh token réutilisé) → accès
   complet, réservation comprise ;
2. **sinon**, session **« email seul »** (`createEmailSession`) — **uniquement si** le compte a
   `passwordHash` **et** `emailVerifiedAt`. Lecture seule : planning, tricount… **mais pas de
   réservation** (celle-ci exige une session ResaMania, cf. `resolveActingContext`) ;
3. **sinon** → **409 « ResaMania expirée »** : la biométrie a réussi mais le lien ResaMania est
   mort et aucun repli e-mail n'existe.

### Fluidification du mur 409 (reconnexion en un geste)

Plutôt que d'éjecter le membre, le 409 renvoie `code: "resa_expired"` + l'**identifiant** du
compte (sûr : la biométrie a prouvé la possession de l'appareil). Le client
(`LoginScreen` via `loginWithPasskey`) bascule alors sur l'onglet ResaMania, **pré-remplit
l'identifiant** et **met le focus sur le mot de passe** → il ne reste qu'à le taper pour
réserver. Vaut **même en auto-connexion silencieuse** au lancement (la biométrie a réussi, ce
n'est pas une annulation à taire).

## Conscience de sauvegarde (synchronisé vs lié à l'appareil)

- `backedUp = true` → passkey **synchronisé** (trousseau iCloud / Google) : survit à la perte
  de l'appareil, se retrouve sur les autres appareils du même compte. Tag **🔁 synchronisé**.
- `deviceType = "singleDevice"` → passkey **lié à cet appareil** seul. Tag **📱 cet appareil**.
- Si **tous** les passkeys d'un membre sont device-bound et **aucun** synchronisé, les Réglages
  affichent un **avertissement lockout** : perdre l'appareil = perdre l'accès biométrique.

## Repères par appareil (localStorage) & relance d'enrôlement

Deux marqueurs **locaux au navigateur** (`src/lib/webauthnClient.ts`), jamais par compte :

- `pk_on_device` (`hasPasskeyOnDevice` / `markPasskeyOnDevice` / `forgetPasskeyOnDevice`) : « un
  passkey a déjà servi ici ». Posé après un enrôlement ou une connexion réussis. Sert à
  n'auto-armer la modale biométrique au lancement **que sur les appareils déjà configurés** —
  jamais de modale surprise sur un appareil vierge (là, on tente l'**autofill conditionnel**).
- `pk_enroll_snooze` : met la **relance d'enrôlement** en veille **7 jours** (bouton « Plus
  tard » ou échec/annulation).

**Relance** (`PasskeyEnrollPrompt`, monté dans `page.tsx`) : après connexion, si l'appareil
supporte la biométrie et n'a **aucun** passkey (ni snooze récent), propose **une fois** de
l'activer. C'est le principal levier d'adoption — sinon la fonction reste enterrée dans les
Réglages.

## Gestion

- **Membre — Réglages** (`SettingsButton`, `showPasskeys = biometry`) : liste de ses passkeys
  avec tag de sauvegarde, date d'ajout / dernière utilisation, **Renommer**
  (`PATCH /passkeys/{id}`) et **Retirer** (`DELETE /passkeys/{id}`).
- **Admin — Membres** (`admin/membres`) : révocation **par appareil** (`revoke_passkey`, borné
  au `userId` ciblé) ou **tout** (`revoke_passkeys`), + **stat d'adoption** « N/M ont activé la
  biométrie ».

## Anti-abus & sécurité

- **Défi à usage unique** : le cookie de défi est **toujours effacé** en fin de cérémonie,
  y compris sur un échec (sinon rejeu possible jusqu'au TTL).
- **Rate-limit par IP** (`passkeyRateLimited` / `recordPasskeyAttempt`) sur le flux
  usernameless (pas d'identifiant à viser) — aligné sur la connexion par mot de passe.
- **Compteur anti-rejeu** : `newCounter` mémorisé à chaque connexion ; une **régression** de
  compteur (signal de clonage possible) fait lever la lib → 401 + log serveur.
- Compte **désactivé** → 403 même si la biométrie est valide.

## Fichiers clés

| Rôle | Fichier |
|---|---|
| Flag (env + clés + libellés) | `src/lib/features.ts` |
| Wrappers navigateur (enroll/login, marqueurs locaux) | `src/lib/webauthnClient.ts` |
| Helpers serveur (rpParams, défi, rate-limit) | `src/lib/webauthn.ts` |
| Cérémonies | `src/app/api/auth/webauthn/{register,auth}/{options,verify}/route.ts` |
| Gestion passkeys (liste / renommer / retirer) | `src/app/api/auth/webauthn/passkeys/**` |
| Écran de connexion (bouton, auto-connexion, reconnexion 409) | `src/components/LoginScreen.tsx` |
| Relance d'enrôlement | `src/components/PasskeyEnrollPrompt.tsx` |
| Réglages (gérer ses passkeys) | `src/components/SettingsButton.tsx` |
| Admin (révocation, stat) | `src/app/admin/membres/page.tsx`, `src/app/api/admin/members/route.ts` |
| Schéma / migration | `prisma/schema.prisma`, `prisma/migrations/10_passkey_backup/` |

## Tests

- `src/lib/features.test.ts` — résolution des flags (dont `biometry`).
- `src/app/api/auth/webauthn/auth/verify/route.test.ts` — échelle de session, 404/429/400/401/403,
  défi usage unique, **payload 409 `resa_expired` + identifiant**.
- `src/app/api/auth/webauthn/register/verify/route.test.ts` — enrôlement, stockage
  `backedUp`/`deviceType`, libellé UA, idempotence.
- `src/app/api/admin/members/route.test.ts` — révocation par appareil / tout.

## Avant d'activer en prod

1. **Migration** : appliquer `10_passkey_backup` sur la base Neon de prod
   (`npx prisma migrate deploy` **en conscience** — le `.env` local pointe sur la prod).
2. **Flag** : `NEXT_PUBLIC_FEATURE_BIOMETRY=1` dans Vercel → Production, puis **redeploy**
   (inliné au build). Ou forcer « active » dans l'admin (à chaud).
3. **RGPD** : vérifier la note « Confidentialité & données » — un passkey est une donnée
   d'authentification liée à l'appareil (clé publique + libellé d'appareil + état de
   sauvegarde) ; s'assurer qu'elle est reflétée.
4. **`rpID`** : les passkeys sont liés au domaine (`rpID`). Un changement de domaine invalide
   les passkeys existants — à garder en tête si l'URL de prod bouge.
