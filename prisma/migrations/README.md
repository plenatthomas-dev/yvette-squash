# Migrations — règle de nommage et pièges

**Préfixe à DEUX CHIFFRES, toujours.** La prochaine migration s'appelle `41_<sujet>`.

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

## Un en-tête de migration est périmé et ne peut pas être corrigé

`29_passkey_backup/migration.sql` commence par « ⚠️ NUMÉRO 27 OBLIGATOIRE — NE PAS
RENUMÉROTER ». Cette consigne datait d'avant le renumérotage général ; le dossier s'appelle
maintenant `29_` et c'est correct, puisqu'il trie toujours après `28_passkey`. Le texte n'est pas
modifié parce que le contenu du fichier est figé par sa somme de contrôle : le réécrire ferait
diverger l'historique. **Ne « réparez » pas ce numéro.**
