# Étude — quitter Neon pour Supabase ?

**Date :** 2026-08-15 · **Branche :** `feature_supabase` · **Statut :** étude close, option A implémentée.

Question posée : migrer la base de Neon vers Supabase pour ne plus être limité en CU-hours.
Ce document mesure d'abord la cause, puis compare les options, puis chiffre le temps.

**Décision : option A** (§5 bis). Les chiffres du §1 ont été **corrigés** le 15/08 après
vérification de la configuration réelle des crons : la première version surestimait la
consommation d'un facteur ~4 en extrapolant une heure de logs à la journée entière.

---

## 1. La cause, mesurée

Le quota ne part pas à cause de la taille des données ni du trafic des membres. Il part à cause
d'**un appel toutes les 4 minutes**, sur une plage de 6 heures par jour.

> ⚠️ **Correction du 15/08 (après vérification de la configuration réelle des crons).** Une
> première version de cette étude annonçait « toutes les 4 minutes, 24 h/24 », soit 182,5
> CU-hours/mois et un dépassement de × 1,83. **C'était faux** : les horodatages des logs Vercel
> sont en UTC, et la rétention des logs sur le plan Hobby n'est que d'une heure — l'échantillon
> observé (15 h 16 → 16 h 12 UTC) correspondait en réalité à 17 h 16 → 18 h 12 à Paris, donc au
> tout début de la plage, pas à un régime permanent. Les chiffres ci-dessous sont les corrigés.

Relevé sur les logs de production Vercel (15/08) :

```
16:12:47 UTC  GET /api/cron/check-alerts 200   (= 18:12 Paris)
16:08:46 UTC  GET /api/cron/check-alerts 200
16:04:46 UTC  GET /api/cron/check-alerts 200
16:01:21 UTC  GET /api/cron/check-alerts 200
15:56:46 UTC  GET /api/cron/check-alerts 200
…                             (intervalle ≈ 4 min, dans la plage 17 h-22 h)
```

Deux crons externes (cron-job.org) tournent, le plan Vercel Hobby plafonnant les crons internes
à 1×/jour :

| Cron | Fréquence | Touche Postgres ? |
|---|---|---|
| `/api/cron/check-alerts` | `*/4 17-22` | oui — `slotAlert.findMany` puis écriture `CronRun` |
| `/api/health` | `*/10 17-21` | oui — `SELECT 1` |

**Neon suspend le compute après 5 minutes d'inactivité.** Un accès toutes les 4 minutes tombe
juste sous ce seuil : pendant toute la plage 17 h-22 h, le compute ne s'endort jamais. Le cron
`/api/health` tombe entièrement dans cette fenêtre — il ne coûte donc rien de plus aujourd'hui,
mais il réveillera la base à lui seul (5 min par appel, toutes les 10 min) une fois `check-alerts`
assagi. Autrement dit : il réveille Neon pour mesurer la latence de réveil de Neon.

| | |
|---|---|
| Compute éveillé (plage des crons + marge de suspension) | ≈ 6 h/jour, soit ~182 h/mois |
| Plancher du plan gratuit | 0,25 CU |
| Consommation imputable aux crons | ≈ **46 CU-hours/mois** |
| Trafic des membres (mesuré en juillet, ~39 % du temps éveillé) | ≈ 25 CU-hours/mois |
| Quota gratuit Neon | **100 CU-hours/mois** |

On **frôle** le quota (une alerte « 80 % » a été reçue le 23/07 à 81 CU-hours), on ne le dépasse
pas d'un facteur deux. Le fichier `src/lib/app-block.ts` porte d'ailleurs déjà ce commentaire :
« chaque requête en plus réveille Neon ».

**Conséquence directe : changer de base n'est pas la seule façon de régler le problème posé.**
Réduire simplement la fréquence du poll ne suffit pas (chaque réveil coûte 5 min de compute :
poller toutes les 6 min laisse encore ~92 % du temps éveillé). Il faut soit une base qui ne facture
pas le temps de compute, soit ne plus réveiller Postgres pour rien.

---

## 2. Ce qui nous lie à Neon : presque rien

Inventaire fait sur le code :

| Point d'accroche | Constat |
|---|---|
| Driver | `@prisma/client` standard, `provider = "postgresql"` |
| Adaptateur Neon (`@neondatabase/serverless`) | **absent** du `package.json` |
| Extensions Postgres | **aucune** (`previewFeatures`/`extensions` non utilisés) |
| Types `Unsupported`, `citext`, `uuid-ossp` | **aucun** |
| SQL propriétaire dans les migrations | **aucun** |
| Modèles | 26, tous en SQL standard |
| Découplage | `DATABASE_URL` (pooled) + `DIRECT_URL` (direct) — exactement le schéma attendu par Supabase |

**Le code est portable tel quel.** Aucune ligne applicative à réécrire : la migration se joue
entièrement sur les variables d'environnement et le transfert des données.

---

## 3. Le vrai obstacle : la chaîne de migrations ne reconstruit PAS une base vierge

Découvert en testant, pas en lisant. Sur un Postgres 16 vide :

```
$ npx prisma migrate deploy
Migration name: 10_tricount_comments
Database error: ERROR: relation "Tricount" does not exist
```

**Cause** : les dossiers ne sont pas numérotés à largeur fixe. Prisma les trie par
`localeCompare` sur le nom de dossier, où `10_` passe **avant** `2_` :

```
ordre réel :    0_init  1_booking_unique  10_tricount_comments  11_delegation  …  2_user_nickname
ordre voulu :   0_init  1_booking_unique  2_user_nickname  …  10_tricount_comments
```

> **Correction.** Une version antérieure de ce document attribuait le défaut à un tri ASCII
> (« `10_` avant `1_` »). Vérifié depuis : `localeCompare` classe bien `1_booking_unique` avant
> `10_tricount_comments`. Le défaut est réel sous les deux collations, mais c'est `10_` contre
> `2_` qu'il faut avoir en tête.

`10_tricount_comments` référence la table `Tricount`, créée par `4_tricount` — qui ne passera que
bien plus tard. La base de production, elle, n'a jamais vu le problème : chaque migration y a été
appliquée au fil de l'eau, dans l'ordre de création.

**Vérification que la chaîne est saine par ailleurs** — copie renumérotée en `01_`…`31_`, rejouée
sur une base vierge :

```
All migrations have been successfully applied.   (31 migrations, 4 secondes)
$ prisma migrate diff --from-url <base> --to-schema-datamodel prisma/schema.prisma --exit-code
No difference detected.                          (27 tables = 26 modèles + _prisma_migrations)
```

La chaîne est donc **complète et exacte** : seul son nommage est cassé.

### Ce que ça implique

1. **Ça ne bloque pas une migration par dump/restore** (voir §5) : on copie la base, historique
   `_prisma_migrations` compris, et `migrate deploy` n'a plus rien à appliquer.
2. **Mais ça bloque toute création d'un environnement neuf depuis les migrations** — nouvelle
   base de preview, poste de dev vierge, et plus généralement tout plan B.
3. ⚠️ **Renommer les dossiers n'est pas anodin** : les noms sont enregistrés dans la table
   `_prisma_migrations` de la base de PRODUCTION. Les renuméroter sans traiter la prod ferait
   croire à Prisma que 31 migrations inconnues restent à appliquer. La correction propre est
   `prisma migrate resolve --applied <nouveau_nom>` pour chacune, ou un `UPDATE` sur la table.
   **À faire une fois, à froid, jamais dans le même lot qu'autre chose.**

---

## 4. Comparaison des options

### Option A — Rester sur Neon, ne plus le réveiller pour rien

Sortir de Postgres la seule question posée toutes les 4 minutes : « existe-t-il une alerte
active ? ». Un drapeau dans Vercel Edge Config (inclus, gratuit) ou Upstash Redis suffit ; on ne
touche Postgres que si la réponse est oui. `recordCronRun` doit suivre le même chemin.

- ✅ Aucune migration de données, aucun risque sur les données, réversible en un commit.
- ✅ Garde le PITR 24 h du plan gratuit Neon, et les branches Neon par environnement.
- ✅ Ramène la consommation à quelques CU-hours/mois (le compute ne s'éveille que si une alerte
  existe — rare pour un club de cette taille).
- ❌ Une dépendance de plus, et du code à écrire et tester.
- ❌ Ne supprime pas le principe de la facturation au temps de compute : un futur usage
  (dashboard temps réel, polling plus large) reposera la question.

### Option B — Migrer vers Supabase (plan gratuit)

- ✅ **Supprime la contrainte à la racine** : Supabase ne facture pas de CU-hours. Le poll de
  4 minutes devient sans effet sur la facture.
- ✅ La mise en pause après 7 jours d'inactivité ne nous concerne pas : le poll maintient le
  projet éveillé en permanence.
- ✅ Région `eu-central-1` (Francfort) disponible, cohérente avec le `regions: ["fra1"]` de
  `vercel.json` — c'est ce rapprochement fonctions/base qui avait réglé la lenteur.
- ✅ Code portable tel quel (§2).
- ❌ **Aucune sauvegarde automatique ni PITR sur le plan gratuit.** Neon gratuit offre un PITR
  24 h ; Supabase gratuit, rien — il faut mettre en place un `pg_dump` planifié. Pour une appli
  qui porte des réservations et des comptes partagés, ce n'est pas un détail.
- ❌ **2 projets maximum** sur le plan gratuit, alors qu'il existe aujourd'hui 4 périmètres de
  base (`Production`, `Preview`, `Preview (dev)`, `Preview (feature/tricount)`). Il faudra
  consolider — Neon, avec son modèle de branches, était plus souple là-dessus.
- ❌ 500 Mo de stockage (a priori large, **mais non vérifié** — cf. §6).
- ❌ Pièges de connexion à traverser une fois (§5).

### Option C — Rester sur Neon et payer

Plan Launch, facturation à l'usage sans minimum : 182,5 CU-h × 0,106 $ ≈ **19 $/mois**, plus le
stockage (0,35 $/Go-mois). Zéro travail, zéro risque, PITR porté à 7 jours.

À comparer à Supabase Pro (25 $/mois) si l'on veut chez eux les sauvegardes quotidiennes.

### Synthèse

| | Coût mensuel | Travail | Risque données | Sauvegardes |
|---|---|---|---|---|
| **A** — corriger le poll | 0 € | 2–4 h | nul | PITR 24 h (conservé) |
| **B** — Supabase gratuit | 0 € | 5–8 h | réel (transfert) | **à construire** |
| **C** — Neon Launch | ≈ 19 $ | 0 h | nul | PITR 7 jours |

---

## 5. Chiffrage du temps — si l'option B est retenue

| Étape | Temps | Remarque |
|---|---|---|
| Créer le projet Supabase (région Francfort), récupérer les chaînes | 15 min | |
| `pg_dump` de Neon → `psql` vers Supabase, `_prisma_migrations` inclus | 30–45 min | base petite ; l'essentiel est la vérification |
| Variables Vercel : `DATABASE_URL` + `DIRECT_URL` × 4 périmètres + `.env` local | 30 min | ne pas oublier les scopes Preview |
| **Pièges de connexion** | **1–2 h** | c'est là que ça coince toujours (détail ci-dessous) |
| Consolider 4 périmètres de base en 2 projets | 30–60 min | décisions à prendre, pas juste de la config |
| Recette fonctionnelle : login, planning, réservation, tricount, tournoi, crons, alertes | 1 h | |
| Mettre en place un `pg_dump` planifié (remplace le PITR perdu) | 1–2 h | **non optionnel** |
| **Total réaliste** | **5–8 h** | soit une demi-journée à une journée, Neon gardé chaud une semaine en repli |

### Les pièges de connexion, en détail

1. **`DATABASE_URL` doit viser Supavisor en mode transaction** (port `6543`) **avec
   `?pgbouncer=true`**. Sans ce paramètre, Prisma envoie des *prepared statements* que le pooler
   en mode transaction ne peut pas honorer → erreurs intermittentes, difficiles à lire.
2. **`DIRECT_URL` doit rester joignable depuis le build Vercel.** C'est critique ici : le
   `package.json` lance `prisma migrate deploy` **pendant le build**. Or la connexion *directe*
   Supabase est en IPv6 seul (sans l'option IPv4 payante) : il faut donc pointer `DIRECT_URL` sur
   le pooler en **mode session** (port `5432`), pas sur l'hôte direct.
3. **Le couplage build ↔ base redevient un sujet.** Un build qui échoue parce que la base ne
   répond pas est déjà un point ouvert du backlog d'audit (« sortir `prisma migrate deploy` du
   build ») ; la migration est l'occasion de le traiter.
4. **Utilisateur `prisma` dédié** plutôt que `postgres`, comme le recommande la doc Supabase.

---

## 5 bis. Décision prise (2026-08-15)

**Option A retenue, plus le renumérotage des migrations.** La taille de la base a été relevée :
**9,9 Mo** — les 500 Mo du plan gratuit Supabase auraient donc été très larges, mais l'option A
reste préférable pour les raisons du §7.

Ce qui a été implémenté dans la foulée, sur cette branche :

- `src/lib/alerts-gate.ts` — la question « existe-t-il une alerte active ? » est servie par le
  Data Cache de Vercel, pas par Postgres. Aucun service ni secret à provisionner, et le repli
  est sûr : un cache froid relit la base, soit exactement le comportement d'avant.
- Le battement de cœur du cron est posé au moment du rafraîchissement horaire de cette porte —
  c'est le seul instant où la base est de toute façon réveillée.
- Invalidation à chaque changement réel : création, suppression, expiration, notification.
- Une date d'alerte est désormais bornée à l'horizon réservable (J+14), côté API **et** côté
  cron : une alerte pour 2027 ne se déclencherait jamais mais tiendrait la porte ouverte pour
  toujours, ce qui aurait annulé tout le bénéfice sans que rien ne le signale.
- Les 31 dossiers de migration sont préfixés `01_` à `31_`, et le dépôt reconstruit désormais
  une base vierge (vérifié : `migrate diff` ne détecte aucune différence). La relabellisation de
  `_prisma_migrations` sur les bases existantes est **automatique et idempotente**
  (`prisma/renumerotation-migrations.sql`, joué par `db:deploy` avant `migrate deploy`) : pas
  d'étape manuelle à oublier, donc pas d'ordre à respecter.

**Consommation attendue après coup** : le compute ne s'éveille plus pour les alertes que
lorsqu'il y en a une, plus une fois par heure pour rafraîchir la porte — les ~46 CU-hours/mois
imputables à `check-alerts` tombent à quelques unités. ⚠️ **Mais `/api/health` reste** : seul,
il réveille la base 5 min toutes les 10 min de 17 h à 21 h, soit ~2 h 30/jour ≈ 19 CU-hours/mois.
Le supprimer (ou le faire répondre sans toucher Postgres) est le prochain gain évident.

---

## 6. Le chiffre qui manquait — relevé : 9,9 Mo

La question était de savoir si le plan gratuit Supabase (500 Mo) suffirait. Réponse : très
largement. Requête utilisée, à rejouer si la question se repose :

```sql
SELECT pg_size_pretty(pg_database_size(current_database())) AS taille_totale;

SELECT relname AS table, pg_size_pretty(pg_total_relation_size(c.oid)) AS taille
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 10;
```

Les tables à surveiller restent `RequestLog` (12 mois de rétention), `PlanningSnapshot`,
`Booking` et `Attendance` : c'est par elles que la croissance viendrait. Une base au-delà de
~300 Mo rendrait le plan gratuit Supabase inconfortable — on en est loin.

---

## 7. Recommandation

**Commencer par l'option A**, pour trois raisons : elle traite la cause réelle (un poll qui
réveille Postgres 360 fois par jour pour, la plupart du temps, n'apprendre qu'il n'y a rien à
faire), elle ne met aucune donnée en jeu, et elle est réversible. Elle laisse aussi le PITR en
place — ce que la migration gratuite vers Supabase ferait perdre.

**La migration vers Supabase reste tout à fait faisable** — le code est portable, le chiffrage
tient dans une journée — mais elle échange une contrainte de compute contre une contrainte de
sauvegardes et un plafond de 2 projets. Elle se justifie si l'on veut sortir par principe de la
facturation au temps de compute, moins comme réponse à ce dépassement précis.

**Dans tous les cas, et indépendamment de la décision : corriger la numérotation des migrations.**
Aucun environnement neuf ne pouvait être créé à partir du dépôt. C'était vrai avec Neon comme
avec Supabase, et c'est ce qui aurait rendu n'importe quel plan B impraticable le jour où il
aurait fallu l'exécuter. **Fait sur cette branche.** La relabellisation des bases existantes est
automatique (`npm run db:deploy` la joue avant `migrate deploy`), donc il n'y a aucune étape
manuelle à ne pas oublier.

⚠️ **Un prérequis subsiste avant la fusion**, et il n'est pas technique mais organisationnel :
toutes les branches encore déployables doivent porter le renumérotage, sans quoi l'une d'elles
rejouerait les 31 migrations sur une base déjà relabellisée. La procédure complète — prérequis,
retour arrière, critère de retrait du script — vit dans `prisma/migrations/README.md`, qui fait
foi sur ce sujet.
