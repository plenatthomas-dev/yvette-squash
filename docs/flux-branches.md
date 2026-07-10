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

1. **Migrations** : appliquer les migrations Prisma manquantes sur la base Neon de prod
   (`npx prisma migrate deploy` avec la `DATABASE_URL` de prod). ⚠️ le `.env` local pointe
   sur la prod — ne jamais lancer ça par accident, le faire en conscience.
2. **Flag** : passer `NEXT_PUBLIC_FEATURE_XXX=1` dans Vercel → Settings → Environment
   Variables → **Production**.
3. **Redeploy** : les `NEXT_PUBLIC_*` sont inlinés au build → un redéploiement est
   obligatoire (redeploy Vercel ou commit vide : `git commit --allow-empty -m "chore: redeploy"`).
4. **RGPD** : si la fonction expose de nouvelles données, vérifier que la note
   « Confidentialité & données » (`PrivacyNotice`, `page.tsx`) a son paragraphe — il
   s'affiche automatiquement avec le flag.

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
- La base de données de la recette est celle configurée dans l'env **Preview** de Vercel —
  idéalement une branche Neon séparée de la prod, pour tester les migrations sans risque.

## Aide-mémoire

```bash
# Propager main vers Recette (après tout push sur main)
git checkout Recette && git merge main && git push && git checkout main

# Appliquer les migrations sur la prod (en conscience !)
npx prisma migrate deploy

# Forcer un rebuild sans changement de code (flags modifiés)
git commit --allow-empty -m "chore: redeploy (flags)" && git push
```
