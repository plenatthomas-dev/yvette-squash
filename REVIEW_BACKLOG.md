# Review backlog

Findings du blind-review non résolus immédiatement, tracés ici pour ne pas les
perdre. Géré par le système `blind-review` (voir `~/.claude/skills/blind-review`).

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
