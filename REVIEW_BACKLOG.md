# Review backlog

Findings du blind-review non résolus immédiatement, tracés ici pour ne pas les
perdre. Géré par le système `blind-review` (voir `~/.claude/skills/blind-review`).

---

## Blind-review 2026-07-24 — diff e1f541a51527a887 (round 1, pass)

Champ `lastSeenAt` (dernière activité réelle) distinct de `lastLoginAt` (dernière authentification) ; affichage admin sur deux lignes.
VERDICT : 0 BLOCKER, 0 MAJOR, 3 MINOR, 1 INFO. Aucun bloquant → commit débloqué.

- [x] [MINOR] ~~`touchLastSeen` awaité sans isolation → un échec d'écriture ferait planter la bannière publique (500)~~ — CORRIGÉ : appel entouré d'un `.catch(() => {})` (best-effort).
- [x] [MINOR] ~~Docstring « lecture seule / VOLONTAIREMENT légère » et commentaire « 1 écriture/h » devenus inexacts~~ — CORRIGÉ : docstrings reformulées (requête émise à chaque appel vs écriture effective throttlée).
- [x] [MINOR] ~~`getLiveSessionUserId` fait 2 allers-retours DB en série (findUnique + updateMany) sur le chemin chaud~~ — CORRIGÉ 2026-07-24 : l'écriture `lastSeenAt` est désormais cadrée sur le cookie (filtre `sessions: { some }`) au lieu du userId, ce qui la rend indépendante de la lecture → les deux requêtes tournent en parallèle (`Promise.all`), un seul aller-retour de latence.
- [INFO] Juste après déploiement, « Dernière connexion » (`lastSeenAt`) affiche « — » pour tous jusqu'à leur prochaine visite — src/app/admin/membres/page.tsx. **Non traité** : transitoire et cosmétique ; les deux lignes étant affichées, l'absence est auto-explicative (« Dernière authentification » reste renseignée).

## Blind-review 2026-07-21 — diff e2463dfbd47ef70a (round 1, pass)

Bouton admin « Rafraîchir les classements » + fonction partagée `refreshRankings`.
VERDICT : 0 BLOCKER, 0 MAJOR, 3 MINOR, 2 INFO. Aucun bloquant → commit débloqué.

- [x] [MINOR] ~~Le run manuel écrase le heartbeat `warm-rankings`~~ — CORRIGÉ 2026-07-21 : le bouton écrit désormais sous une clé distincte `warm-rankings-manuel` → ne masque plus une panne du cron planifié.
- [x] [MINOR] ~~Réponse squashnet vide (200) ⇒ suppression de classements valides~~ — 1re correction (signal `rows.length > 0`) jugée INSUFFISANTE à la re-revue (cf. MAJOR ci-dessous), puis CORRIGÉE pour de bon le 2026-07-21.
- [MINOR] Pas de verrou anti-concurrence (bouton + cron, ou 2 admins) — src/lib/squashnet/refresh.ts — double salve vers squashnet, compteurs non représentatifs. Pas de corruption (idempotent par userId). Piste : garde-fou léger basé sur CronRun.lastRunAt. **Non traité** (impact limité).
- [INFO] Divergence de contrat `month === null` : cron 200 vs bouton 502 — volontaire (UX différentes), noté pour un futur monitoring.
- [INFO] Risque de timeout partiel sur maxDuration=60 si l'annuaire grossit — src/app/api/admin/refresh-rankings/route.ts:8 — pré-existant, identique au cron ; envisager traitement par lots au-delà de quelques dizaines de membres listés.

---

## Blind-review 2026-07-21 — diff 589b600d253ca0ab (round 1) — re-revue des correctifs

Re-revue des correctifs des 2 MINOR ci-dessus. VERDICT : 0 BLOCKER, 1 MAJOR, 2 MINOR, 2 INFO.

- [x] **[MAJOR]** ~~Le « signal positif d'absence » (`rows.length > 0`) supprimait encore des classements valides~~ (pagination page 2 sur noms courants ; homonymes internes ambigus) — CORRIGÉ 2026-07-21 : nouveau classifieur `classifyRanking` (match.ts) à 3 verdicts. On ne supprime QUE sur `moved` (nom du membre retrouvé uniquement HORS du club) ; « pas de hit » / ambiguïté / réponse vide ⇒ `unknown` ⇒ on ne touche à rien. Tests dédiés (match.test.ts + refresh.test.ts).
- [x] [MINOR] ~~Erreurs d'écriture DB comptées comme « squashnet sans réponse »~~ — CORRIGÉ (affiné au tour 3, cf. ci-dessous) : compteur `failed` distinct, jamais confondu avec squashnet.
- [x] [MINOR] ~~Libellé UI approximatif pour `skipped`~~ — CORRIGÉ : message neutre « (non concluant) » (couvre réponse vide ET hoquet réseau).
- [INFO] `warm-rankings-manuel` s'affiche comme un « cron » vert figé dans le dashboard — accepté (objectif du fix atteint ; simple lisibilité).
- [INFO] `matched + cleared + skipped` ne partitionne pas `members` (displayName vide, déjà-à-jour-sans-changement) — accepté ; le texte dit « sur N listés » (total balayé).

---

## Blind-review 2026-07-21 — diff cc6c0ea4c2fd617e — re-revue #2 (disjoncteur)

VERDICT : 0 BLOCKER, 1 MAJOR, 3 MINOR, 2 INFO.

- [x] **[MAJOR]** ~~Un renommage du libellé du club côté squashnet transformait TOUS les membres en `moved` → effacement massif silencieux~~ — CORRIGÉ 2026-07-21 : disjoncteur de volume dans `refreshRankings` (suppressions différées + neutralisées si `moved >= 4` ET `> 34 %` des membres balayés → `bulkMoveBlocked`). Signalé en erreur à l'admin et heartbeat `ok=false`. Tests dédiés.
- [x] [MINOR] ~~Batch non atomique : 1re erreur DB avortait tout le lot~~ — CORRIGÉ : écriture base entourée d'un try PAR membre → erreur comptée `failed`, le lot continue (plus de propagation qui tue le batch).
- [x] [MINOR] ~~Heartbeat `ok:true` même si 100 % `skipped`~~ — CORRIGÉ : `summarizeRefresh` dérive `ok` de `failed`/`bulkMoveBlocked`/(`skipped == members`).
- [MINOR] `cleared` compte des LIGNES DB, `matched`/`skipped` des MEMBRES — écart possible entre la somme et N. **Non traité** (cosmétique ; `cleared` = « classements réellement retirés », sémantique honnête).
- [INFO] Faux `moved` résiduel via homonyme plein-nom exact + pagination (membre en page 2, homonyme d'un autre club en page 1) — fenêtre très étroite ; le disjoncteur borne l'ampleur. **Non traité** (suivre la pagination si l'annuaire grossit).
- [INFO] `skipped` agrège erreur réseau et réponse vide, UI « (non concluant) » — accepté (déjà tracé).

---

## Blind-review 2026-07-21 — diff 030d9aef7347275e — re-revue #3 (finitions)

VERDICT : 0 BLOCKER, 0 MAJOR, 3 MINOR, 2 INFO. Aucun bloquant → commit débloqué.

- [x] [MINOR] ~~UI admin (bannière verte) et heartbeat divergeaient sur « squashnet muet » (`skipped == members`)~~ — CORRIGÉ : la route renvoie `ok` (même critère que `summarizeRefresh`) et le client s'aligne dessus (plus de faux succès vert).
- [x] [MINOR] ~~`displayName` vides diluaient le ratio du disjoncteur et le critère « tous ignorés »~~ — CORRIGÉ : les noms vides sont filtrés en amont ; `members` ne compte que les évaluables.
- [MINOR] Ratio du disjoncteur calculé sur tous les membres évaluables, pas sur la population effectivement jugeable (`matched + moved`) : une grosse fraction en timeout réseau pourrait laisser passer une suppression de masse *partielle*. **Non traité** (le filtrage des noms vides atténue ; borné par le nombre de `moved` ; à revoir si besoin).
- [INFO] Faux `moved` isolé (homonyme plein-nom + pagination) — idem entrées précédentes, suivre si l'annuaire grossit.
- [INFO] Plancher `BULK_MOVE_MIN=4` peu opérant pour un très petit club (≤ ~11 membres) — acceptable (l'annuaire est destiné à grossir).

---

## Blind-review 2026-07-19 — audit complet du code (pas de diff ; round 1)

VERDICT initial : 0 BLOCKER, 1 MAJOR, 3 MINOR, 3 INFO.
Le MAJOR a été corrigé le 2026-07-19 (rate-limiting login email par identifiant).
Reste ci-dessous : 3 MINOR + 3 INFO.

### Corrigé
- [x] **[MAJOR]** Login email/mot de passe : rate-limiting par IP seulement.
  `src/app/api/auth/email/login/route.ts` — ajout du comptage/écriture par
  `identifier` (2 dimensions IP + compte), à l'image de `src/app/api/auth/login/route.ts`.
  Corrigé le 2026-07-19, tests OK (305/305), tsc OK.

### À traiter (MINOR)
- [ ] **[MINOR]** Tricount — dette imposée sans retrait possible.
  `src/app/api/tricount/expenses/route.ts:102-110`,
  `src/app/api/tricount/expenses/[id]/route.ts:36,86-92`.
  N'importe qui peut désigner un autre membre comme payeur/participant ; l'intéressé,
  s'il n'est ni créateur ni payeur, ne peut ni éditer ni supprimer la ligne.
  → Permettre à un participant de retirer sa propre part, ou exiger validation du
  payeur désigné quand ce n'est pas le créateur. (Modèle « registre partagé » assumé,
  d'où MINOR — mais l'asymétrie mérite un garde-fou.)

- [ ] **[MINOR]** Enrôlement passkey — `catch {}` traite toute erreur comme un succès.
  `src/app/api/auth/webauthn/register/verify/route.ts:89-91`.
  Une panne DB pendant l'enrôlement affiche « passkey ajouté » alors que rien n'est
  stocké → biométrie perçue comme cassée ensuite.
  → Ne rattraper que la violation d'unicité (P2002) ; laisser remonter le reste en 500.

- [ ] **[MINOR]** finals — message d'erreur brut renvoyé au client.
  `src/app/api/tournaments/[id]/finals/route.ts:50`.
  Le fallback renvoie `(e as Error).message` pour toute exception non-Prisma ; un
  refactor futur de `materializeFinals` pourrait faire fuiter un message d'implémentation.
  → Message générique par défaut ; n'exposer que des erreurs métier explicitement typées.

### À garder en tête (INFO)
- [ ] **[INFO]** Inscription email déjà rattachée à un compte ResaMania non signalée à l'admin.
  `src/app/api/auth/email/register/route.ts:64-73`.
  L'admin ne voit pas que l'email correspond déjà à un membre existant → une approbation
  de bonne foi peut mener à poser un mot de passe sur un compte existant puis (via passkey
  + option A) restaurer un accès ResaMania complet. Seul garde-fou : la diligence de l'admin.
  → Afficher « cet email a déjà un compte » dans la file d'attente `/admin`.

- [ ] **[INFO]** Score de match écrasable par tout participant.
  `src/app/api/tournaments/[id]/matches/[mid]/route.ts:56-58`.
  Autorisation « participant OU créateur » sans restreindre aux joueurs du match ; via la
  cascade d'invalidation, un seul membre peut réinitialiser tout le tableau. Design
  coopératif assumé — à revoir si la confiance entre participants ne suffit plus.

- [ ] **[INFO]** Secret cron accepté en query string.
  `src/lib/cron-auth.ts:27`.
  `?token=$CRON_SECRET` se retrouve dans les logs d'accès Vercel et les referrers.
  → Privilégier l'en-tête `Authorization` ; réserver `?token=` au cron externe qui ne
  peut pas poser d'en-tête.
