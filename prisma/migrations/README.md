# Migrations — règle de nommage et pièges

**Préfixe à DEUX CHIFFRES, toujours.** La prochaine migration s'appelle `56_<sujet>`.

**Et un numéro ne se prend qu'UNE fois.** Le numéro se choisit d'après `main`, au moment de
créer la migration — pas d'après sa propre branche, qui ignore ce que les autres ont posé
depuis. Voir « Deux branches, un même numéro » plus bas.

## Pourquoi la largeur fixe

Prisma applique les migrations dans l'ordre du **nom de dossier**, trié par `localeCompare`.
Sans largeur fixe, l'ordre obtenu n'est pas l'ordre numérique :

```
0_init · 1_booking_unique · 10_tricount_comments · 11_delegation · 2_user_nickname · …
```

`10_` passe donc avant `2_`. (Ce n'est pas un tri ASCII — sous ASCII, `1_` passerait après `10_`
et le symptôme serait différent. Le défaut existe sous les deux collations, mais ne se raconte
pas de la même façon : c'est bien `10_` vs `2_` qu'il faut avoir en tête.)

Ce défaut a coûté deux incidents :

- **2026-07-17** — `10_passkey_backup` (un `ALTER TABLE "Passkey"`) triait avant `26_passkey`
  (le `CREATE TABLE`). La production a reçu les deux d'un coup : l'ALTER s'est exécuté en
  premier et a échoué (`relation "Passkey" does not exist`, P3018), bloquant le déploiement et
  exigeant un `migrate resolve --rolled-back` à la main. La production garde de cet épisode une
  ligne `10_passkey_backup` **annulée** dans `_prisma_migrations` : inoffensive, ne la supprimez
  pas sans raison.
- **2026-07-12** — constat plus large : aucune base vierge ne pouvait être reconstruite depuis
  le dépôt, `10_tricount_comments` référençant `Tricount` avant que `4_tricount` ne la crée.

**Corrigé le 2026-08-15** : les 31 dossiers ont été renumérotés `01_` → `31_`. Le dépôt
reconstruit désormais une base vierge (`migrate deploy` puis `migrate diff` : aucune différence).

## ⚠️ Le renumérotage engage les BASES, pas seulement le dépôt

Les anciens noms vivent dans `_prisma_migrations`. Deux scripts font le pont, tous deux
idempotents, sans effet sur une base vierge, incapables de créer un doublon, et conçus pour
**échouer bruyamment** plutôt que de laisser un état mixte :

| Sens | Commande | Quand |
|---|---|---|
| anciens noms → `01_`…`31_` | `npm run db:renumerote` | **automatique** : joué par `npm run db:deploy` avant `migrate deploy` |
| `01_`…`31_` → anciens noms | `npm run db:renumerote:retour` | **à la main**, avant de redéployer du code d'avant le renumérotage |

Les deux commandes lisent la base de `DATABASE_URL`. Pour viser la production depuis un poste :
récupérer la chaîne via `neonctl connection-string production --project-id … --org-id …` et la
passer en variable d'environnement — ne jamais l'écrire dans un fichier suivi.

**À retirer un jour.** Le script aller est joué à chaque déploiement alors qu'il n'a de sens
qu'une fois par base : chaque build ouvre pour lui une connexion de plus. Il pourra être
supprimé — avec `db:renumerote` dans `package.json` — quand toutes les bases auront été
converties **et** qu'aucune branche déployable ne portera plus les anciens noms. Vérification :
`SELECT count(*) FROM "_prisma_migrations" WHERE migration_name !~ '^[0-9]{2}_'` doit rendre 0
sur chaque base.

### Le piège à connaître avant de fusionner

Une base relabellisée face à un code portant encore `0_init` fait voir à Prisma **31 migrations
pendantes**. Il rejoue `01_init` sur une base peuplée, échoue (`relation "User" already exists`),
et tous les déploiements suivants échouent ensuite jusqu'à une intervention manuelle. Or
`01_init/migration.sql` n'est pas idempotent, et son contenu ne peut pas être corrigé (la somme
de contrôle est enregistrée en base).

Concrètement, **avant de fusionner ce changement** :

1. porter le renumérotage sur toutes les branches encore déployées (au 2026-08-15 : `main`,
   `Recette`, `feature/biometrie`, `feature_impeccable` portaient toutes `0_init` et pas le
   script) — le plus simple étant de les réaligner sur `main` juste après la fusion ;
2. se souvenir qu'un `git revert`, un hotfix sur un ancien tag ou un redéploiement d'un commit
   antérieur exigent de jouer **le script de retour** d'abord.

## Deux branches, un même numéro

**Arrivé le 2026-09-11.** `feature_captain`, créée avant que `main` ne pose
`51_squashnet_ranking_probe`, avait numéroté `51_interclub_official`. Pendant ce temps
`feature_audit` posait `52_index_purges` et la branche captain avait déjà son `52_`.

**Git ne dit rien** : ce sont des dossiers différents, la fusion est propre. L'arbre fusionné
aurait simplement porté deux `51_` et deux `52_`. Ça aurait même *fonctionné* — les quatre
migrations sont indépendantes, et `localeCompare` leur donne un ordre quelconque mais valide.
C'est précisément ce qui rend le piège dangereux : il ne se manifeste pas le jour où on le
pose, mais le jour où deux migrations homonymes ont, elles, une dépendance.

### Comment on l'a dénoué, et ce que ça coûte

Les trois migrations de la branche ont été renumérotées `53_`, `54_`, `55_` — **avant** la
fusion vers `main`, seul moment où c'est gratuit. La production ne les avait jamais vues.

⚠️ **Mais la base `dev` les avait déjà**, sous leurs anciens noms : toutes les previews la
partagent, et la branche y avait déjà été déployée. Pour Prisma, un nom nouveau est une
migration pendante — il allait la rejouer sur une base portant déjà ses objets, échouer en
`already exists` (P3018) et bloquer les déploiements de preview jusqu'à un `migrate resolve`
à la main.

Plutôt qu'une intervention manuelle sur une base qu'on ne peut pas atteindre depuis un poste,
les trois migrations ont été rendues **rejouables** : `CREATE TABLE IF NOT EXISTS`,
`ADD COLUMN IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS`, et pour la contrainte de clé
étrangère — qui ne connaît pas `IF NOT EXISTS` — un `DROP CONSTRAINT IF EXISTS` avant l'ajout.
La base `dev` se répare donc toute seule au déploiement suivant, et une base vierge ne voit
aucune différence. Les lignes des anciens noms restent dans son `_prisma_migrations`,
inoffensives — comme `10_passkey_backup` en production.

Réécrire le corps d'une migration est normalement interdit (la somme de contrôle est en base).
Ici c'était libre : **sous le nouveau nom, aucune base n'avait de somme enregistrée.** C'est la
seule fenêtre où l'on peut le faire, et elle se referme à la première application.

Preuve faite sur Docker avant la fusion : base vierge → `migrate deploy` → `migrate diff` sans
différence ; puis les trois lignes de `_prisma_migrations` remises à leurs anciens noms pour
simuler `dev`, une donnée insérée, `migrate deploy` rejoué — appliqué sans erreur, donnée
intacte, `migrate diff` toujours sans différence.

## Un en-tête de migration est périmé et ne peut pas être corrigé

`29_passkey_backup/migration.sql` commence par « ⚠️ NUMÉRO 27 OBLIGATOIRE — NE PAS
RENUMÉROTER ». Cette consigne datait d'avant le renumérotage général ; le dossier s'appelle
maintenant `29_` et c'est correct, puisqu'il trie toujours après `28_passkey`. Le texte n'est pas
modifié parce que le contenu du fichier est figé par sa somme de contrôle : le réécrire ferait
diverger l'historique. **Ne « réparez » pas ce numéro.**
