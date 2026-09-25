# 🎯 Étude — un marqueur de points accessible hors interclub

- **Statut** : 💡 à étudier · **Valeur** ⭐⭐ · **Effort** S–M (phase 1)
- **Question** : sortir le module de comptage des points de l'interclub pour en faire une
  entrée du menu général ? Et si oui, faut-il garder les scores, et où ?

---

## 1. Résumé

- **Oui, c'est une bonne idée** : le cœur du marquage est déjà une logique **pure**
  (`src/lib/interclub.ts`) sans lien avec la base. Seul l'écran `InterclubScorer` est couplé à
  une rencontre.
- **Stockage recommandé : sur le téléphone uniquement (localStorage)**, avec un petit
  historique local des derniers matchs. Pas de table, pas de migration, pas d'impact RGPD.
- **Le serveur ne vaut le coup que plus tard**, et seulement pour un besoin précis
  (brancher le marqueur sur les **tournois**, ou suivre un match en direct à plusieurs).

---

## 2. Constat : aujourd'hui, le marqueur est enfoui

Chemin actuel : `⋯` → **Interclub** → ouvrir une rencontre → composer le simple (adversaires) →
**Marquer**. Quatre écrans et une donnée métier (la composition) avant le premier point.

Conséquences :

- **Invisible** pour qui ne joue pas l'interclub (la majorité des membres).
- **Inutilisable** pour un match amical, un entraînement, une finale de tournoi interne.
- **Masqué** si le flag `interclub` est coupé : le marqueur disparaît avec lui.

### Ce qui est réutilisable tel quel

| Élément | Fichier | Couplé à l'interclub ? |
|---|---|---|
| Règles (11 pts, 2 d'écart, bo3/bo5, pause 2 min) | `lib/interclub.ts` (`POINTS_TO_WIN`, `MIN_LEAD`, `BREAK_SECONDS`) | ❌ non |
| Journal d'événements + rejeu + undo | `lib/interclub.ts` (`ScoreEvent`, `replay`, `applyPoint`, `applyServe`, `undo`) | ❌ non |
| Couleurs d'équipe lisibles | `lib/interclub.ts` (`resolveColor`, `inkFor`) | ❌ non |
| Écran allumé | `lib/wake-lock.ts` | ❌ non |
| Écran de marquage (UI) | `components/InterclubScorer.tsx` | ⚠️ **oui** |

### Ce qui couple l'écran à l'interclub

Dans `InterclubScorer.tsx` :

- props `fixtureId`, `match: MatchInfo` (id de simple, jeux connus du serveur, `live`) ;
- synchro `PUT /api/interclub/{id}/matches/{mid}/live` toutes les 5 s, avec **concurrence
  optimiste** (`ic:ack:`, `knownGameCount`, `stale-games`) et **prise de marquage** (claim) ;
- `seedEvents` à partir des jeux serveur ;
- `onExpired` (session).

Cette partie synchro est **la plus délicate du fichier** (nombreux correctifs de pertes de
données documentés en commentaire). ⚠️ **Il ne faut pas la toucher** pour le marqueur libre.

---

## 3. Faut-il garder les scores ? — les options

| # | Option | Pour | Contre | Effort |
|---|---|---|---|---|
| **A** | **Rien** (score en mémoire, perdu à la fermeture) | Trivial | Un rechargement / verrouillage agressif iOS = match perdu. **Inacceptable** au bord du court. | XS |
| **B** | **localStorage : match en cours** | Reprise après rechargement, 100 % hors ligne (sous-sol), zéro serveur | Perdu si on change de téléphone | S |
| **C** | **B + historique local** (10 derniers matchs terminés) | « Mes derniers matchs », partage du résultat, toujours zéro serveur, zéro RGPD | Pas multi-appareil, pas de stats club | S–M |
| **D** | **Table serveur `FreeMatch`** | Historique multi-appareil, suivi en direct par d'autres, stats | Migration Prisma, noms libres de non-membres → **note de confidentialité + durée de conservation** (`retention.ts`), coût DB (Neon), gestion concurrence à refaire | L |
| **E** | **Pont vers les tournois** : le marqueur écrit le résultat final dans `Match.score1/score2` | Valeur réelle : les tournois internes n'ont aujourd'hui qu'une saisie « 3-1 » à boutons | Dépend des droits tournoi (participant/créateur), à concevoir à part | M |

### Recommandation : **C maintenant, E ensuite, D seulement sur demande**

Raisons :

1. **Un match amical n'a pas de valeur partagée** : personne d'autre n'a besoin du score
   après coup. Le stocker côté serveur, c'est de la donnée nominative sans usage.
2. **Local-first est déjà le parti pris du marqueur** (« une salle de squash est un
   sous-sol »). L'option C le prolonge sans rien ajouter.
3. **Zéro impact RGPD** : rien ne quitte le téléphone → pas de ligne à ajouter dans
   `PrivacyNotice`, pas de purge serveur à écrire.
4. **Le vrai besoin serveur est le tournoi** (E), qui a déjà ses tables (`Match`) : pas besoin
   d'en créer une nouvelle.

---

## 4. Plan d'implémentation (option C)

### Étape 1 — Extraire l'écran de marquage (refactor sans changement de comportement)

- Extraire de `InterclubScorer.tsx` un composant **présentationnel** `ScoreBoard` :
  boutons de point, undo, choix du serveur / carré, pause, écran de fin.
- `InterclubScorer` = `ScoreBoard` + sa synchro serveur **inchangée**.
- ✅ Les tests `InterclubScorer*.dom.test.tsx` doivent passer **sans modification** : c'est la
  preuve que le refactor est neutre.

### Étape 2 — Créer `FreeScorer`

- `components/FreeScorer.tsx` = `ScoreBoard` + stockage local.
- Écran de départ : 2 noms (texte libre, défaut « Joueur 1 / Joueur 2 »), 2 couleurs
  (`COLOR_PRESETS`), format bo3 / bo5.
- Stockage (préfixe **distinct** de `ic:log:` pour ne jamais collisionner) :

```ts
// lib/free-scorer.ts — module PUR, testable sans DOM
const CURRENT_KEY = "free:current";   // match en cours (un seul à la fois)
const HISTORY_KEY = "free:history";   // matchs terminés, du plus récent au plus ancien
export const MAX_HISTORY = 10;
export const HISTORY_TTL_DAYS = 30;

export type FreeMatch = {
  id: string;                          // crypto.randomUUID()
  startedAt: number;
  home: { name: string; color: string | null };
  away: { name: string; color: string | null };
  bestOf: 3 | 5;
  events: ScoreEvent[];                // le journal : l'état se DÉRIVE par replay()
};

/** Ajoute un match terminé, garde les MAX_HISTORY plus récents de moins de TTL jours. */
export function pushHistory(list: FreeMatch[], m: FreeMatch, now = Date.now()): FreeMatch[] {
  const ttl = HISTORY_TTL_DAYS * 86_400_000;
  return [m, ...list.filter((x) => x.id !== m.id && now - x.startedAt < ttl)].slice(0, MAX_HISTORY);
}
```

- Lecture/écriture enveloppées dans `try/catch` (mode privé, quota) : **on continue en
  mémoire**, comme `saveLog` aujourd'hui.
- On stocke le **journal** (`events`), pas le score : undo et reprise restent exacts.

### Étape 3 — Brancher dans l'appli

1. `lib/features.ts` : ajouter `scorer` à `FEATURE_KEYS`, `FEATURE_LABELS`, `ENV_FEATURES`
   (`NEXT_PUBLIC_FEATURE_SCORER`) → pilotable depuis `/admin` comme les autres.
2. `lib/views.ts` : ajouter `"scorer"` à `VIEWS` (le test associé vérifie la survie au
   rafraîchissement).
3. `app/page.tsx` : entrée `HeaderMenu` **« Marqueur »**, indépendante du flag `interclub` :

```tsx
{
  key: "scorer",
  label: "Marqueur",
  icon: <ScoreIcon />,
  active: view === "scorer",
  disabled: !scorer,
  comingSoon: !scorer,
  onClick: () => setView(view === "scorer" ? "day" : "scorer"),
},
```

4. Écran de fin : **« Partager le résultat »** (Web Share API, repli copie presse-papier)
   → « Paul 3-1 Marc (11-7, 9-11, 11-4, 11-8) ». Remplace avantageusement un stockage
   serveur pour 90 % des besoins (envoyer le score sur le groupe WhatsApp).

### Étape 4 — Tests

- `lib/free-scorer.test.ts` : `pushHistory` (plafond, TTL, dédoublonnage), reprise d'un
  match en cours.
- `FreeScorer.dom.test.tsx` : rechargement en cours de match → même score ; stockage refusé →
  on compte quand même.

---

## 5. Pièges à éviter

- ⚠️ **Ne pas réutiliser `InterclubScorer` avec un faux `fixtureId`** : il partirait en
  `PUT /api/interclub/...` et la logique de conflit (`clearLog` sur `stale-games`) pourrait
  effacer le journal.
- ⚠️ **Préfixe localStorage distinct** (`free:` vs `ic:`) : sinon un match libre et un simple
  d'interclub pourraient partager un journal.
- ⚠️ **Ne pas mélanger les matchs libres aux stats interclub** (`/api/interclub/stats`) : ils
  n'ont ni licence ni adversaire vérifié.
- ⚠️ **Un seul match en cours** à la fois : proposer « Reprendre / Nouveau match » à
  l'ouverture, jamais écraser silencieusement.
- ⚠️ Si l'option D est retenue un jour : **noms libres = potentiellement des non-membres** →
  mise à jour obligatoire de `PrivacyNotice` + constante dans `retention.ts` (règle du
  projet : « une note qui promet une durée que le code ne tient pas est pire que rien »).

---

## 6. Alternatives

1. **Raccourci seul, sans nouveau module** : un bouton « Marquer un match » dans l'onglet
   Interclub qui crée une rencontre « amicale » éphémère. ❌ Pollue le calendrier interclub,
   les notifications de suivi et les stats. Déconseillé.
2. **Option C (recommandée)** : module autonome, local, partage du résultat.
3. **Option C + E** : même chose, plus un bouton « Marquer » sur chaque match de tournoi qui
   ouvre `FreeScorer` pré-rempli et, à la fin, envoie le score en jeux à
   `PATCH /api/tournaments/{id}/matches/{mid}` (endpoint existant). Le score point par point
   reste local ; seul le résultat officiel du tournoi part au serveur.

---

## 7. Estimation

| Étape | Effort |
|---|---|
| 1. Extraction `ScoreBoard` (refactor neutre) | S |
| 2. `FreeScorer` + stockage local | S |
| 3. Flag, vue, menu, partage | XS |
| 4. Tests | S |
| **Total phase 1 (option C)** | **M (≈ 2 j)** |
| Phase 2 — pont tournoi (E) | M |
| Phase 3 — stockage serveur (D), si demandé | L |
