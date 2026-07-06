# 💡 Idées de développement — backlog

Idées de fonctionnalités proposées par un **bêta-testeur**, complétées d'une **analyse**
(qualité, effort, priorisation). Ce fichier est un _backlog_ de travail.

- **Statut** : `💡 à étudier` · `👍 retenu` · `🚧 en cours` · `✅ fait` · `❌ écarté`
- **Effort** (ordres de grandeur, projet solo) : `XS` <½ j · `S` ½–1 j · `M` 2–4 j ·
  `L` 4–6 j · `XL` 1–2 sem.
- **Valeur** (utilité pour l'asso) : ⭐ faible · ⭐⭐ moyenne · ⭐⭐⭐ forte.
- Les blocs « _Notes / éval_ » sont mes annotations, **pas** les mots du testeur.

> **Méthode.** Estimations ancrées dans le code réel : adaptateur ResaMania
> (`src/lib/resamania/client.ts`), réservation (`api/book`), présence/« +1 »
> (`api/presence`), vues `PlanningGrid` (jour) et `WeekGrid` (semaine).
> **Contraintes structurantes** qui reviennent partout :
> 1. l'API ResaMania est **interne / rétro-ingénierie** — chaque réservation = un
>    `POST /attendees` avec le **jeton du membre** (pas d'API batch) ;
> 2. règle ResaMania **« un seul terrain par horaire »** ;
> 3. plan **Vercel Hobby = cron quotidien** (pas de tâche infra-journalière) ;
> 4. **RGPD** : une note de confidentialité est déjà en prod → toute nouvelle donnée
>    exposée doit y être reflétée.

---

## 1. Réserver plusieurs créneaux d'un coup ✅ fait

Pouvoir **réserver tout un créneau récurrent sur la semaine** (le même horaire chaque
jour), ou plus généralement **réserver plus vite plusieurs créneaux à la fois**.

- **Statut** : ✅ fait (avec 7b) · **Valeur** ⭐⭐⭐ · **Effort** M
- **Notes / éval** : recoupe l'idée 7b. Faisabilité **bonne** : le cas « même horaire toute
  la semaine » est naturel car des jours différents ne déclenchent pas la règle « un
  terrain par horaire » (contrainte 2). Pas d'API batch (contrainte 1) → **boucle de N
  appels côté serveur**. Points à traiter : **échecs partiels** (dire lesquels ont réussi /
  échoué), rester raisonnable en volume pour ne pas se faire repérer côté ResaMania.
  **Verdict** : à faire, à concevoir avec 7b.
- **Livré** (`feature/vue-semaine` → `main`) : mode « Sélection » piloté depuis la barre de
  vue (icône), présent en **vue jour** (`PlanningGrid`) **et semaine** (`WeekGrid`). En
  semaine, un clic sur l'horaire coche **le même créneau sur toute la semaine** (`toggleRow`),
  répondant au cas « récurrent ». Réservation groupée = **boucle de N `POST /api/book`**
  (contrainte 1) avec **gestion des échecs partiels** (`onBookMany` dans `page.tsx` :
  compteur `done` + liste `fails`, **plafond d'aperçu à 10**, toast récapitulatif
  « X confirmées · Y échecs »). Règle « un terrain par horaire » respectée (sélection
  radio par horaire).

## 2. Reprise automatique d'un terrain libéré par le « +1 »

Si la **personne 1** réserve, que la **personne 2** se met en « +1 », et que la personne 1
se **désinscrit**, la réservation est **automatiquement reprise par la personne 2**.

- **Statut** : 💡 à étudier · **Valeur** ⭐⭐ · **Effort** L · ⚠️ risque élevé
- **Notes / éval** : le « +1 » = modèle `Attendance` (signal **purement local**, ne touche
  pas ResaMania). Réserver **au nom de** la personne 2 exige **sa session** (refresh token
  chiffré en base, valable ~30 j) encore valide **et son consentement**. Déclencheur :
  - annulation **dans l'app** (`api/cancel-slot`) → on peut enchaîner la résa de la
    personne 2 **immédiatement** (fiable, faisable) ;
  - annulation **directement sur ResaMania** → l'app ne le sait pas en direct ; seul le
    cron le verrait, or **cron quotidien** (contrainte 3) = trop lent, le créneau part au
    public avant.
  Donc **scope réaliste = hook sur l'annulation in-app uniquement**. Gérer une file de
  priorité si plusieurs « +1 ». **Verdict** : à **cadrer** (périmètre in-app + consentement
  explicite) avant tout code — sinon usine à gaz. Alternative plus simple : idée **D**.

## 3. Module de gestion de tournois internes

Une liste de personnes s'inscrit, l'appli **génère le meilleur format** (poules /
quarts-demies-finale) **selon le nombre de participants et de matchs souhaité**.

- **Statut** : 💡 à étudier · **Valeur** ⭐⭐ · **Effort** XL
- **Notes / éval** : module **autonome complet** — nouveaux modèles (tournoi, match,
  résultat), **algorithme de bracket & poules paramétrable**, UI de suivi + saisie des
  scores. Gros chantier, isolé du reste. Réutilise l'annuaire (6). **Verdict** : à réserver
  **si les tournois sont fréquents** ; sinon repousser (rapport valeur/effort faible pour
  un usage ponctuel).

## 4. Délégation temporaire de droits

Un utilisateur **délègue momentanément ses droits** à un autre (ex. gérer les réservations
d'une soirée à sa place).

- **Statut** : 💡 à étudier · **Valeur** ⭐⭐ · **Effort** M–L · ⚠️ sensible sécurité
- **Notes / éval** : mécanisme « **agir au nom de** » avec **expiration** + **traçabilité**
  (qui a agi pour qui). **Surtout pas de partage du mot de passe ResaMania** → délégation
  **applicative** : un droit temporaire adossé aux sessions, la résa réelle se faisant avec
  le jeton du délégant. Bien border la portée (quelles actions ? quelle durée ?).
  **Verdict** : utile pour l'orga de soirées ; faisable mais **demande un design sécurité
  soigné**.

## 5. Messagerie entre utilisateurs

**Communiquer entre utilisateurs** — par exemple à propos d'un tricount.

- **Statut** : 💡 à étudier · **Valeur** ⭐⭐ · **Effort** variable
- **Notes / éval** : deux périmètres très différents :
  - **(a) fil de commentaires attaché à un tricount** → **S–M**, ciblé, directement utile
    au partage de frais ;
  - **(b) messagerie générale** entre membres → **L–XL** (fils, non-lus, modération,
    notifs) et **dépend de l'annuaire (6)**.
  Web Push (`PushSubscription`) déjà en place pour notifier. **Verdict** : commencer par
  **(a)**, remettre (b) à plus tard.

## 6. Annuaire des utilisateurs inscrits

**Liste des membres** pour faciliter la recherche (ex. choisir un destinataire de message).

- **Statut** : 💡 à étudier · **Valeur** ⭐⭐ (surtout comme brique) · **Effort** S
- **Notes / éval** : liste dérivée du modèle `User` (nom réel + pseudo). ⚠️ **RGPD** :
  exposer les membres est une **nouvelle finalité** → à refléter dans la note de
  confidentialité, idéalement en **opt-in** (chacun choisit d'apparaître). **Débloque
  3, 4 et 5b**. **Verdict** : bon investissement transverse, peu cher.

## 7. Sélection multi-créneaux + couleurs asso en vue semaine ✅ fait

Sur la **vue semaine** : **sélectionner plusieurs créneaux** (cf idée 1) et voir **qui a
réservé** via un code couleur (asso vs autre asso) — **comme en vue jour**.

À traiter en **deux morceaux distincts** :

- **7a — Cellule bicolore par terrain en vue semaine** · ✅ fait · **Valeur** ⭐⭐⭐ · **Effort** S
  (la modale de détail existe déjà, à enrichir)
  **Livré** : chaque case semaine est **bicolore** (`wk-seg` par terrain, ordre stable
  gauche→droite trié par nom) avec la **palette vue jour** — `free`/`asso`/`other`/`mine`/
  `past`/`closed` (`segOf`, `SEG_LABEL`). Contrairement au design initial (« moitiés non
  cliquables »), **chaque terrain est cliquable indépendamment** (réserve / annule / ouvre
  le détail). La **modale « week-detail »** est enrichie : nom du réservataire (`bookedBy`),
  « +1 » (`attendees`), actions (réserver, +1, annuler) + garde « un seul terrain à la fois ».
  Accessibilité couverte (`aria-label`/`title` par segment, `SEG_LABEL`).
  **La donnée existe déjà** : chaque `Slot` porte son état (`bookable`, `bookedBy`,
  `mine`…) — c'est ce que `PlanningGrid` (vue jour) exploite. `WeekGrid` reçoit **les mêmes
  slots** mais réduit aujourd'hui les cases réservées à « 0 ».
  **Design retenu** (profite du fait qu'il n'y a que **2 terrains**) : chaque cellule
  (jour × horaire) est **coupée en deux moitiés** — **gauche = Squash 1, droite = Squash 2**
  (ordre fixe, tri par nom) — chacune colorée avec **la palette de la vue jour** : vert
  `--free` = libre, **bleu `--group` = réservé asso**, rose `--booked` = réservé hors asso,
  gris `--closed` = pas de créneau, + état « passé ». La vue semaine devient une **mini
  vue-jour**.
  **Interaction (pensée mobile)** : les moitiés ne sont **pas** des cibles de clic — trop
  petites au doigt en vue semaine. La **cellule entière reste cliquable** (gros tap-target)
  et ouvre une **modale de détail des 2 terrains** — on **réutilise/enrichit la modale
  « week-sheet » déjà présente** dans `WeekGrid` (qui ne liste aujourd'hui que les terrains
  libres). Chaque terrain y est listé avec sa **couleur/état**, **qui a réservé**
  (`bookedBy`) et **les « +1 »** (`attendees`), plus les actions : réserver un terrain
  libre, se mettre « +1 » sur un terrain asso — soit exactement les infos/actions de la vue
  jour. **La bicolore sert au coup d'œil, la modale à l'action.**
  **À border** : `title`/aria sur la cellule (accessibilité — ne pas reposer sur la couleur
  seule, le détail complet étant dans la modale) ; cas limites (deux libres, deux réservés,
  une moitié fermée, créneau passé). ⚠️ Bicolore **couplée à « 2 terrains »** : à revoir si
  le club en ajoute (le découpage deviendrait illisible au-delà de 2-3).
  _NB : la **multi-sélection** pour réserver plusieurs cellules d'un coup (idées 1/7b) reste
  un mécanisme distinct (mode sélection) — ici on ne traite que le détail/action d'**une**
  cellule._
- **7b — Sélection multiple + réservation groupée** · ✅ fait · **Valeur** ⭐⭐⭐ · **Effort** M
  État de sélection sur la grille + action « tout réserver » + échecs partiels →
  **recoupe l'idée 1**. À concevoir ensemble.
  **Livré avec l'idée 1** (voir détail ci-dessus) : `selMode`/`selected` remontés à la page,
  barre d'action collante (`wk-actionbar`), sélection radio par horaire, `onBookMany` avec
  échecs partiels.

---

## ➕ Idées complémentaires (ajoutées à l'analyse)

- **A. Rappels de match (push avant le créneau)** · ⭐⭐⭐ · **M**
  Réutilise `PushSubscription`. ⚠️ cron quotidien (contrainte 3) → rappel « le matin
  même » réaliste ; « 1 h avant » supposerait de densifier le cron (limite du plan Hobby).
- **C. Ajout au calendrier (export `.ics`)** · ⭐⭐ · **S**
  Générer un fichier ICS d'une réservation pour l'agenda perso. Aucun accès ResaMania.
- **D. Liste d'attente sur créneau complet** · ⭐⭐⭐ · **M**
  Version **plus simple et moins risquée que l'idée 2** : s'inscrire en attente sur un
  créneau plein → **notification** (push, infra existante) quand il se libère ; la
  réservation reste **manuelle**. Étend le modèle `SlotAlert` (déjà « préviens-moi si un
  terrain se libère »). Bon compromis valeur/risque.

---

## 📊 Analyse & priorisation

Rapport valeur / effort (⚠️ estimations grossières, projet solo) :

| # | Idée | Valeur | Effort | Dépend de | Priorité |
|---|------|:------:|:------:|-----------|----------|
| 7a | Cellule bicolore par terrain (semaine) | ⭐⭐⭐ | S | — | ✅ **fait** |
| 1 + 7b | Réservation groupée & multi-sélection | ⭐⭐⭐ | M | — | ✅ **fait** |
| 6 | Annuaire (opt-in) | ⭐⭐ | S | — | **Haute** (brique) |
| C | Export `.ics` | ⭐⭐ | S | — | Moyenne |
| A | Rappels de match (push) | ⭐⭐⭐ | M | — | Moyenne-haute |
| 5a | Commentaires sur un tricount | ⭐⭐ | S–M | — | Moyenne |
| D | Liste d'attente | ⭐⭐⭐ | M | SlotAlert | Moyenne (alt. de 2) |
| 4 | Délégation de droits | ⭐⭐ | M–L | — | À cadrer (sécurité) |
| 2 | Reprise auto via « +1 » | ⭐⭐ | L | Attendance | À cadrer (risqué) |
| 5b | Messagerie générale | ⭐⭐ | L–XL | 6 | Basse |
| 3 | Tournois internes | ⭐⭐ | XL | 6 | Basse (si tournois fréquents) |

### Séquencement recommandé (par vagues)

1. **Vague 1 — quick wins** (fort effet, peu cher) : ~~**7a** (couleurs semaine)~~ ✅,
   **6** (annuaire opt-in), **C** (.ics). → **reste 6, C**.
2. **Vague 2 — feature phare** : ~~**1 + 7b** (réservation groupée + sélection multiple)~~ ✅.
3. **Vague 3 — engagement** : **A** (rappels push), **5a** (commentaires tricount),
   **D** (liste d'attente).
4. **Vague 4 — gros / sensibles, à décider** : **4** (délégation, design sécurité),
   **2** (auto-rebook, à cadrer), **3** (tournois, si fréquents), **5b** (messagerie).

> **État au 2026-07-06** : la **vague 2** (feature phare) et **7a** de la vague 1 sont
> **livrées** (branche `feature/vue-semaine` fusionnée dans `main`, en prod). Prochain
> palier logique : **finir la vague 1** (6, C). _Idée B (stats perso) écartée._

### Lecture d'ensemble (qualité des idées)

- **Les meilleures** : **7a** et **1/7b** (réservation) — pile sur le cœur de l'app, forte
  valeur, coût raisonnable, et **7a** presque « gratuite » vu que la donnée est déjà là.
  → **toutes deux livrées** (juillet 2026).
- **Bon rapport valeur/effort** : **6, C, A, 5a, D** — bricks utiles et bornées.
- **Séduisantes mais à cadrer** : **2** (fragile : cron quotidien + consentement +
  concurrence avec le public → **D** est une alternative plus sûre) et **4** (sécurité).
- **Lourdes pour la valeur** : **3** (tournois) et **5b** (messagerie générale) — à ne
  lancer que si le besoin est confirmé et récurrent.

## Recoupements à garder en tête

- **1 + 7b** : même fonctionnalité sous deux angles → à concevoir ensemble.
- **2 ↔ D** : la liste d'attente (D) couvre 80 % du besoin de l'idée 2 pour une fraction
  du risque → privilégier D, garder 2 pour plus tard.
- **5 + 6** : la messagerie générale (5b) a besoin de l'annuaire ; commencer par 5a
  (commentaires tricount), qui n'en dépend pas.
- **3, 4, 5b** réutilisent tous l'annuaire (6).
