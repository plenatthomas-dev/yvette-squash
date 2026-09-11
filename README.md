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
- **Base** : Prisma + **Postgres** partout — Neon (plan gratuit) en production comme en preview,
  un conteneur jetable en local. `schema.prisma` déclare `provider = "postgresql"` : SQLite
  n'est pas une option, et ne l'a pas été depuis longtemps. Une base de développement d'un
  autre moteur que celui de production ne prouverait de toute façon rien des migrations.
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

# Une base Postgres jetable, la même recette que les tests (cf. src/lib/pg-harness.ts) :
docker run --rm -d --name pg-dev -e POSTGRES_PASSWORD=dev -p 55432:5432 postgres:16
# → dans .env : DATABASE_URL et DIRECT_URL = postgresql://postgres:dev@localhost:55432/postgres

npm run db:migrate          # applique les migrations sur cette base
npm run dev                 # http://localhost:3000
```

⚠️ **`.env` peut viser la production.** C'est le cas sur le poste principal — d'où la base
jetable ci-dessus, et la prudence avec toute commande `prisma` lancée à la main.

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
3. **Planifier le cron** — `vercel.json` déclare `/api/cron/check-alerts` à **`0 7 * * *`**,
   soit une fois par jour.
   > ⚠️ Le plan **Hobby** limite les crons à 1×/jour : une expression sub-quotidienne fait
   > **échouer le déploiement**. C'est pourquoi les six crons de `vercel.json` sont tous
   > quotidiens ou mensuels. Pour une vraie fréquence courte, il faut le plan **Pro** ou un
   > cron externe gratuit (ex. cron-job.org) appelant
   > `https://<app>/api/cron/check-alerts?token=$CRON_SECRET` — c'est déjà la solution retenue
   > pour le keep-alive Neon (cf. `docs/neon-keep-alive.md`).
4. Le **build** crée les tables `PushSubscription` / `SlotAlert` : il joue les migrations
   lui-même (cf. « Migrations » ci-dessous).

---

## Roadmap & état des lieux

Le socle historique (adaptateur ResaMania, réservation, journal partagé, déploiement
Vercel + Neon) est **en production** depuis 2026. S'y sont ajoutés : vue semaine,
réservation groupée multi-créneaux, alertes & liste d'attente (Web Push), annuaire des
membres, partage de frais (« tricount »), module tournois, classement fédéral
(squashnet.fr) et sa **courbe de progression**, délégation temporaire de droits, rencontres
interclub avec marquage en direct, note de confidentialité RGPD.

Les fonctions sensibles restent derrière des **feature flags** (`src/lib/features.ts`),
testées sur la branche `Recette` avant activation en prod.

- **Backlog vivant** (idées, statuts, priorisation) : [docs/idees-developpement.md](docs/idees-developpement.md)
- **Flux de branches & promotion** : [docs/flux-branches.md](docs/flux-branches.md)
- **Interclub** (rencontres par équipes, marquage en direct) : [docs/interclub.md](docs/interclub.md)
- **squashnet.fr** (carte des points d'entrée fédéraux, ce qu'on lit et ce qu'on pourrait lire) : [docs/squashnet.md](docs/squashnet.md)

---

## Branches & déploiements

Le flux `feature/* → main → Recette`, les environnements Vercel et la promotion par
feature flags sont décrits dans **[docs/flux-branches.md](docs/flux-branches.md)**.
Le backlog des idées vit dans [docs/idees-developpement.md](docs/idees-developpement.md).

### Migrations : le build les joue lui-même

⚠️ **`npm run build` applique les migrations avant de compiler**, en production comme en
preview :

```
build
 └─ prisma generate
 └─ db:deploy:retry ──▶ db:renumerote  +  prisma migrate deploy
 └─ next build
```

Conséquence à connaître avant de fusionner : **déployer, c'est migrer**. Aucune étape manuelle
n'est à prévoir, et il ne faut pas non plus en jouer une « au cas où ».

Chaque périmètre Vercel a sa propre `DATABASE_URL` : la **Production** vise sa branche Neon,
et **toutes les previews partagent la branche `dev`** — `Recette` comme les branches de
fonctionnalité, qui n'ont pas de surcharge. Deux branches aux migrations divergentes
déployées en même temps écrivent donc dans la même base. Le détail est dans
[docs/flux-branches.md](docs/flux-branches.md), les pièges de nommage dans
[prisma/migrations/README.md](prisma/migrations/README.md).

---

## Sécurité — règles

- Jamais de mot de passe en clair (chiffrement AES-256-GCM, clé hors du dépôt).
- `.env` et `*.har` sont **gitignorés**. Ne jamais committer de secret.
- En prod, `CREDENTIALS_SECRET` et `DATABASE_URL` vivent dans les variables d'environnement de l'hébergeur.
- Le token ResaMania n'est **pas** renvoyé au navigateur : il reste en base, chiffré, derrière un
  cookie de session `sid` posé `httpOnly` + `sameSite: lax` + `secure` en production
  (`api/auth/login`). **Fait**, et non « à venir » comme l'annonçait cette ligne.
