# 🔀 Branches & environnements — le flux Recette → prod

Comment le code voyage du développement jusqu'aux membres, et à quoi sert la branche
`Recette`. Formalisation du flux en place (juillet 2026).

## Les trois environnements

| Environnement | Branche | Déploiement Vercel | Flags `NEXT_PUBLIC_FEATURE_*` | Qui le voit |
|---|---|---|---|---|
| **Prod** | `main` | Production → `squash-yvette.vercel.app` | **OFF** par défaut (exception : `FEATURE_RANKING`, on) | les membres |
| **Recette** | `Recette` | Preview (URL de branche Vercel) | **ON** (env Preview) | toi + testeurs |
| **Dev** | `feature/*`, `dev` | local (`npm run dev`) ou Preview | selon `.env` local | toi |

**Point clé.** `Recette` ne porte **aucun code propre** : son contenu est identique à `main`
(son seul commit spécifique, `f016d43`, est un commit **vide** qui a servi à créer le
déploiement). Ce qui diffère, c'est **l'environnement** : les variables Preview de Vercel y
activent les flags, donc la recette montre les fonctions que la prod cache. Les flags étant
inlinés **au build** (cf. `src/lib/features.ts`), c'est bien le couple branche + env qui fait
l'environnement de recette.

## Le flux nominal (nouvelle fonctionnalité)

```
feature/xxx ──merge──▶ main ──merge──▶ Recette
                        │                  │
                        ▼                  ▼
                  prod (flag OFF,     recette (flag ON,
                  fonction invisible)  on teste ici)
```

1. Développer sur `feature/xxx`, **gated par un flag** si la fonction est visible/sensible.
2. Merger dans `main` + push. Sans risque pour la prod : le flag y est OFF, la fonction
   est invisible (convention « fail-safe » de `features.ts`).
3. **Propager aussitôt** : `git checkout Recette && git merge main && git push`.
   La recette teste toujours le code le plus récent — un oubli ici fait tester du vieux code.
4. Tester sur l'URL de recette (flags ON).

## Promotion en prod = activer un flag (pas un merge)

Le code étant déjà sur `main`, mettre une fonction en service côté membres consiste à :

1. ~~**Migrations**~~ — **rien à faire**, et surtout **pas** à la main. Cette étape disait
   d'appliquer `prisma migrate deploy` sur la base de prod « en conscience » : c'était faux,
   et dangereux à suivre. `npm run build` joue lui-même `db:renumerote` puis `migrate deploy`
   à **chaque** déploiement, production comprise (cf. § suivant). Le `.env` local pointant sur
   la prod, exécuter la commande à la main ne pouvait qu'ajouter du risque sans rien apporter.
2. **Flag** : passer `NEXT_PUBLIC_FEATURE_XXX=1` dans Vercel → Settings → Environment
   Variables → **Production**.
3. **Redeploy** : les `NEXT_PUBLIC_*` sont inlinés au build → un redéploiement est
   obligatoire (redeploy Vercel ou commit vide : `git commit --allow-empty -m "chore: redeploy"`).
4. **RGPD** : si la fonction expose de nouvelles données, vérifier que la note
   « Confidentialité & données » (`PrivacyNotice`, `page.tsx`) a son paragraphe — il
   s'affiche automatiquement avec le flag.

## Déployer, c'est migrer

⚠️ **`npm run build` applique les migrations avant de compiler.** Ce n'est pas une étape
séparée qu'on déclenche, c'est une conséquence automatique de tout déploiement :

```
build
 └─ prisma generate
 └─ db:deploy:retry ──▶ db:renumerote  +  prisma migrate deploy
 └─ next build
```

Trois conséquences à avoir en tête :

1. **Une migration part en même temps que le code qui l'accompagne.** Pas de fenêtre où le
   code nouveau tourne sur l'ancien schéma — mais pas de fenêtre non plus pour relire la
   migration entre les deux. Elle se relit **avant** la fusion.
2. **Un `git revert` ou un redéploiement d'un vieux commit ne défait pas la migration.**
   Prisma ne sait pas revenir en arrière ; la base garde la colonne. Prévoir des migrations
   *additives* (ajouter, pas renommer ni supprimer) est ce qui rend un retour arrière possible.
3. **`db:renumerote` est joué à chaque build** alors qu'il n'a de sens qu'une fois par base.
   `prisma/migrations/README.md` explique pourquoi, et à quelle condition on pourra le retirer.

Le réessai après 25 s (`db:deploy:retry`) n'est pas de la superstition : une branche Neon
archivée met plus longtemps à se réveiller que le délai de connexion de Prisma, et la
première tentative sert de réveil (commit `a3f6fe5`).

## Hotfix

Correctif urgent ou trivial : commit **directement sur `main`**, push, puis **propagation
immédiate** sur `Recette` (étape 3 du flux nominal). C'est le flux utilisé pour les
correctifs du quotidien.

## Règles

- **On ne merge JAMAIS `Recette` → `main`.** Le flux est à sens unique
  (`main` → `Recette`). Recette n'a rien à apporter à main (contenu identique), et le jour
  où elle portera une config spécifique, celle-ci ne doit pas fuiter en prod.
- **Chaque push sur `main` s'accompagne d'un merge vers `Recette`** — sinon les deux
  divergent silencieusement et la recette ment.
- Les branches `feature/*` sont jetables : supprimées après merge (celles qui restent sur
  origin sont de l'historique).
- **La prod a sa propre branche Neon ; toutes les previews en partagent une autre.** Vérifié
  (`vercel env ls`) : `DATABASE_URL` et `DIRECT_URL` existent séparément en **Production** et
  en **Preview**, et la branche Neon des previews s'appelle `dev` (cf. le commit `a3f6fe5`,
  qui la nomme à l'occasion d'un P1001 au réveil d'une branche archivée). **Un build de
  preview ne peut donc pas migrer la prod** — c'est la garantie qui rend le § précédent
  supportable.
- ⚠️ **Mais `Recette` n'a aucune surcharge `DATABASE_URL`** : ses seules variables par branche
  sont les `RESA_*`. Elle prend donc la Preview générique, c'est-à-dire **la même base `dev`
  que toutes les autres previews** (seules `dev` et `feature/tricount` ont leur propre base).
  Deux branches aux migrations divergentes déployées en même temps écrivent donc dans la même
  base, et la seconde à déployer trouve des colonnes qu'elle ne connaît pas. Ce n'est pas un
  incident aujourd'hui parce qu'une seule fonctionnalité avance à la fois ; ça le deviendra le
  jour où deux se chevaucheront. Le remède, ce jour-là : une `DATABASE_URL` par branche, comme
  `feature/tricount` en a déjà une.

## Aide-mémoire

```bash
# Propager main vers Recette (après tout push sur main)
git checkout Recette && git merge main && git push && git checkout main

# Appliquer les migrations sur la prod (en conscience !)
npx prisma migrate deploy

# Forcer un rebuild sans changement de code (flags modifiés)
git commit --allow-empty -m "chore: redeploy (flags)" && git push
```
