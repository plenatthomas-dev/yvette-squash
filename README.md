# 🎾 Yvette Squash

Appli web pour **réserver des terrains de squash** au Complexe Bures, avec :

- un **planning lisible** (grille terrains × horaires) au-dessus de celui de ResaMania ;
- la **réservation en un tap** via le compte ResaMania de chaque joueur ;
- un **journal partagé** : voir quels amis ont réservé quel créneau ;
- partage facile via un lien (hébergement + base de données gratuits).

> ⚠️ **Cadre.** L'appli automatise l'API **interne** de ResaMania avec **le compte de chaque
> joueur** (le sien). Ce n'est pas l'API partenaire officielle : cela peut être contraire aux
> CGU de ResaMania et l'API peut changer sans préavis. À utiliser pour un usage personnel/entre amis,
> en connaissance de cause.

---

## Architecture

```
Navigateur (React)
      │  fetch /api/*
      ▼
Next.js API routes  ──►  Adaptateur ResaMania (src/lib/resamania/client.ts)  ──►  API ResaMania
(proxy serveur :                                    │
 contourne le CORS,                                 ▼
 garde les secrets)                          Base de données (Prisma)
                                             • Users (joueurs)
                                             • ResaAccount (identifiants chiffrés)
                                             • Booking (journal « qui a réservé quoi »)
```

- **Frontend + backend** : Next.js (App Router, TypeScript) — un seul projet, un seul déploiement.
- **Proxy obligatoire** : le navigateur ne peut pas appeler ResaMania directement (CORS) ;
  tout passe par les API routes côté serveur.
- **Base** : Prisma. SQLite en dev, **Postgres Neon** (gratuit) en prod.
- **Secrets** : les mots de passe ResaMania sont chiffrés en **AES-256-GCM** (`src/lib/crypto.ts`),
  jamais stockés en clair. Deux modes possibles (voir Roadmap) :
  - _sur l'appareil_ : rien côté serveur, réservation à la demande seulement ;
  - _chiffrés en base_ : nécessaire pour la **réservation programmée** (« réserver dès l'ouverture »).

### Le truc important
ResaMania ne dit pas **qui** a réservé un créneau (juste libre/réservé). La vue « quels amis
ont réservé » ne peut donc venir **que** des réservations faites **via cette appli** → table `Booking`.

---

## Démarrage (dev)

```bash
npm install
cp .env.example .env        # puis générer la clé : openssl rand -base64 32  -> CREDENTIALS_SECRET
npm run db:push             # crée la base SQLite locale
npm run dev                 # http://localhost:3000
```

Tant que `RESA_USE_MOCK="1"`, le planning affiché est **factice** : l'UI est pleinement
fonctionnelle pour le développement, sans toucher à ResaMania.

---

## Brancher l'API ResaMania (étape clé)

1. **Capturer un HAR** d'une session connectée (login → planning → éventuellement une réservation).
   Voir les instructions données dans le chat ; le fichier `*.har` est gitignoré (il contient
   mot de passe + jetons).
2. Compléter les 3 fonctions de `src/lib/resamania/client.ts` (blocs `⚠️ À COMPLÉTER DEPUIS LE HAR`) :
   `login()`, `getPlanning()`, `book()`.
3. Tester sans l'UI :
   ```bash
   RESA_USE_MOCK=0 RESA_TEST_USER="..." RESA_TEST_PASS="..." npm run resa:test
   ```
4. Passer `RESA_USE_MOCK="0"` dans `.env` → l'appli utilise les vraies données.

---

## Notifications « créneau libéré » (Web Push)

Depuis la vue **Jour**, toucher un créneau **Réservé** propose « M'alerter 🔔 » : dès qu'un
terrain se libère à cet horaire, le joueur reçoit une **notification push** (même appli fermée).
La cloche du header liste/retire les alertes en cours.

Comment ça marche : une alerte (`SlotAlert`) est enregistrée en base ; un **cron** interroge
périodiquement le planning ResaMania (via la session du joueur) et pousse une notif quand le
créneau redevient réservable, puis désactive l'alerte. L'abonnement de l'appareil est un
`PushSubscription` (service worker `public/sw.js`).

### Mise en place

1. **Générer les clés VAPID** (une fois) :
   ```bash
   npx web-push generate-vapid-keys
   ```
   Renseigner dans `.env` (et les Environment Variables Vercel) :
   `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (mailto).
   Sans ces clés, la fonctionnalité se **désactive proprement** (pas de cloche, pas d'erreur).
2. **Secret du cron** : `CRON_SECRET` (`openssl rand -hex 24`), pour protéger l'endpoint.
3. **Planifier le cron** — `vercel.json` déclare `/api/cron/check-alerts` toutes les 5 min.
   > ⚠️ Les crons Vercel **Hobby** sont limités à ~1×/jour. Pour un vrai « toutes les 5 min »,
   > il faut le plan **Pro**, **ou** un cron externe gratuit (ex. cron-job.org) appelant
   > `https://<app>/api/cron/check-alerts?token=$CRON_SECRET`.
4. `npm run db:push` (ou le build) crée les tables `PushSubscription` / `SlotAlert`.

---

## Roadmap

- [x] Squelette : stack, schéma BDD, adaptateur, planning factice, UI grille
- [] **#1** Câbler l'API ResaMania depuis le HAR (login / planning / réservation)
- [ ] **#5** Réservation à la demande depuis l'appli
- [ ] **#6** Journal partagé (qui a réservé quoi) + identité des joueurs
- [ ] **#7** Déploiement gratuit (Vercel + Neon) + lien partageable
- [ ] _Bonus_ Réservation **programmée** à l'ouverture des créneaux (la « killer feature » du squash)

---

## Sécurité — règles

- Jamais de mot de passe en clair (chiffrement AES-256-GCM, clé hors du dépôt).
- `.env` et `*.har` sont **gitignorés**. Ne jamais committer de secret.
- En prod, `CREDENTIALS_SECRET` et `DATABASE_URL` vivent dans les variables d'environnement de l'hébergeur.
- Le token ResaMania n'est pas renvoyé au navigateur : cookie `httpOnly` côté serveur (à venir).
