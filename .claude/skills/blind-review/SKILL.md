---
name: blind-review
description: Lance une relecture À L'AVEUGLE d'une partie du code par un agent au contexte neuf, qui n'a ni l'intention de l'auteur, ni les messages de commit, ni le plan — seulement les fichiers. Il reconstruit lui-même ce que le code est censé faire, puis cherche les écarts. À utiliser après avoir écrit une fonctionnalité, avant de la fusionner, ou quand on veut un avis que le raisonnement de l'auteur n'a pas déjà contaminé. Ne pas utiliser pour une relecture de style ou de design d'interface (voir le skill impeccable).
version: 1.0.0
user-invocable: true
argument-hint: "[chemin ou nom de fonctionnalité, ex. interclub | src/lib/tricount.ts]"
license: Apache 2.0
---

# Relecture à l'aveugle

## Le problème que ce skill résout

Celui qui vient d'écrire du code ne peut plus le relire. Il sait ce qu'il a voulu faire,
donc il lit son intention à la place de ce qui est écrit. Les commentaires qu'il a laissés
lui semblent vrais parce qu'il se souvient de les avoir pensés — pas parce qu'il vient de
vérifier qu'ils décrivent le code.

Une relecture à l'aveugle coupe cette boucle : un agent au **contexte neuf** reconstruit
depuis les fichiers seuls ce que le code prétend faire, puis cherche là où il ne le fait pas.

## Règle non négociable : le contexte doit être neuf

Lancer l'agent avec `subagent_type: "general-purpose"`. **Jamais `fork`** — un fork hérite du
contexte de l'auteur et hérite donc du biais qu'on cherche précisément à éliminer. Si tu es
toi-même l'auteur du code visé, tu ne peux pas faire cette relecture : tu la délègues.

Ce que le relecteur n'a pas le droit de consulter, et qu'il faut lui interdire explicitement :

- `git log`, `git show`, les messages de commit, les descriptions de PR ;
- les fichiers de plan (`~/.claude/plans/**`), les notes de session, les transcriptions ;
- l'auteur lui-même — il ne pose pas de question sur l'intention, il la déduit.

Ce qu'il a le droit de lire, et doit lire : le code visé, ses tests, le schéma de base, les
migrations, et les documents de règles du dépôt (`PRODUCT.md`, `DESIGN.md`, `docs/**`,
`prisma/migrations/README.md`). Ces documents énoncent des contraintes vérifiables, pas
l'intention d'une fonctionnalité particulière.

## Les commentaires sont des affirmations, pas des preuves

C'est le cœur de la méthode, et ce qui distingue cette relecture d'une relecture ordinaire.

Ce dépôt commente abondamment le *pourquoi*. Chaque commentaire qui affirme une propriété est
une **affirmation à vérifier contre le code** :

> « idempotent », « un seul marqueur à la fois », « ne jette jamais », « borné par la cadence
> du marqueur », « le pire cas atteint 4.58:1 », « appliqué côté serveur »

Pour chacune : où est-ce appliqué ? Quel test la couvre ? Quelle entrée la mettrait en défaut ?
Un commentaire qui affirme une garantie que le code ne tient pas est un défaut **plus grave**
qu'un code sans commentaire, parce qu'il empêche le prochain lecteur de regarder.

## Méthode

1. **Cartographier** — lister les fichiers de la fonctionnalité : lib, routes, composants,
   schéma, migrations, tests. Ne rien lire d'autre.
2. **Reconstruire le contrat** — depuis le code et les tests seuls, écrire en trois phrases ce
   que cette fonctionnalité est censée garantir. Si c'est impossible, c'est déjà un constat.
3. **Vérifier les affirmations** — relever les propriétés affirmées en commentaire, et
   confronter chacune à l'implémentation.
4. **Chercher les défauts** — voir `reference/checklist.md` pour les classes de défauts qui
   comptent dans ce dépôt.
5. **Prouver ou jeter** — toute constatation doit s'accompagner d'un scénario concret :
   entrées ou état → comportement observé → comportement attendu. Ce qui ne se prouve pas se
   range à part, en « soupçons », ou se jette.

## Ce qu'on ne veut pas

- **Pas de compliments.** Une relecture n'est pas une évaluation. Une seule phrase suffit pour
  dire que le reste tient ; le reste du rapport porte sur ce qui ne tient pas.
- **Pas de constatation inventée pour paraître utile.** « Rien trouvé sur ce point » est une
  réponse honnête et précieuse. Un rapport gonflé de remarques cosmétiques noie les vraies.
- **Pas de réécriture.** Le relecteur ne modifie aucun fichier du projet. Il décrit.
- **Pas de goût.** Le nommage, l'ordre des fonctions et le style ne sont pas le sujet, sauf
  s'ils induisent réellement en erreur.

## Format du rapport

L'agent écrit son rapport dans un fichier et n'en renvoie qu'un résumé. Chaque constatation :

```
### [gravité] Titre court
**Fichier** chemin:ligne
**Constat** ce que le code fait
**Scénario** entrées ou état → ce qui se produit → ce qu'on attendait
**Affirmation contredite** le commentaire ou le test qui prétend le contraire (s'il existe)
```

Gravités : `bloquant` (perte ou fuite de données, faille, casse en production),
`sérieux` (comportement faux dans un cas atteignable), `mineur` (gêne, dette),
`soupçon` (non prouvé, à confirmer).

Trier par gravité décroissante. Terminer par ce qui a été **vérifié sans rien trouver** —
c'est la partie qui dit au lecteur jusqu'où la relecture est allée.

## Invocation

```
Agent(
  subagent_type: "general-purpose",
  description: "Relecture à l'aveugle <cible>",
  prompt: <le gabarit ci-dessous, cible substituée>
)
```

Gabarit de prompt — le recopier tel quel, **sans y ajouter le moindre mot sur l'intention du
code**, sous peine de ruiner l'exercice :

> Tu fais une relecture À L'AVEUGLE de `<CIBLE>` dans le dépôt `<RACINE>`.
>
> Tu n'as pas l'intention de l'auteur, et tu ne dois pas la chercher. **Interdit** : `git log`,
> `git show`, messages de commit, fichiers de plan, notes de session. Tu déduis ce que le code
> est censé faire **du code et de ses tests seuls**.
>
> Tu peux et dois lire : les fichiers de la cible, leurs tests, `prisma/schema.prisma`, les
> migrations, `PRODUCT.md`, `DESIGN.md`, `docs/**`, `prisma/migrations/README.md`.
>
> Traite chaque commentaire affirmant une propriété (« idempotent », « ne jette jamais »,
> « côté serveur », une borne chiffrée…) comme une AFFIRMATION À VÉRIFIER, jamais comme un
> fait. Un commentaire qui promet une garantie non tenue est un défaut grave.
>
> Suis la méthode et le format décrits dans `.claude/skills/blind-review/SKILL.md` et la liste
> de contrôle `.claude/skills/blind-review/reference/checklist.md`.
>
> Ne modifie aucun fichier du projet. Écris ton rapport dans `<SORTIE>` et renvoie un résumé
> de dix lignes au plus : nombre de constatations par gravité, et les trois plus graves.
>
> Ne cherche pas à me faire plaisir. Si tu ne trouves rien de sérieux, dis-le.

## Après la relecture

Relayer les constatations à l'utilisateur — le rapport de l'agent ne lui est pas montré.
Pour chacune : la corriger, la contester avec un argument, ou la noter comme acceptée. Ne pas
appliquer en bloc : une relecture à l'aveugle produit aussi des faux positifs, précisément
parce qu'elle ignore l'intention. C'est le prix de son indépendance, et c'est un prix correct.
