# Page Admin — fonctions envisagées

Idées de fonctionnalités pour l'espace administrateur (`/admin`), à prioriser.
Contexte : petite asso, accès admin par allowlist `ADMIN_EMAILS` (env serveur). Infra déjà
en place réutilisable : notifications push (VAPID, `pushToUser`), file de demandes
d'inscription/réinitialisation, annuaire des membres, Tricount, tournois, alertes de terrain,
intégration ResaMania.

État actuel de `/admin` : file d'attente des demandes de compte / réinitialisation
(approuver → génère le lien à transmettre, rejeter). Badge de compteur dans le menu.

---

## 🥇 Priorité haute (fort rapport valeur / effort, réutilise l'existant)

### 1. Gestion des membres
Page listant tous les comptes : nom, email, mode (ResaMania / email seul), date d'inscription,
dernière connexion. Actions :
- **désactiver / supprimer** un compte (remplace le nettoyage manuel en base) ;
- **renvoyer un lien d'activation** ou **forcer une réinitialisation** ;
- repérer les comptes non vérifiés / inactifs.

> Note technique : la suppression d'un membre peut être bloquée par des relations `Restrict`
> (dépenses Tricount `payer`/`creator`, parts de dépense). Prévoir de gérer/supprimer ces
> dépendances (cf. la suppression manuelle d'`atomap` faite en dev).

### 2. Annonce push à tous les membres
Formulaire admin « titre + message » → notification push à tous les abonnés
(« Terrain fermé samedi », « Tournoi ce weekend »). Réutilise directement l'infra push.
Quasi gratuit à coder, très utile pour un club.

### 3. Bannière d'annonce dans l'appli
Message éditable par l'admin, affiché en haut de l'appli pour tous. Complément non-intrusif
de la push (pour ceux qui n'ont pas activé les notifs).

---

## 🥈 Priorité moyenne (supervision / confort)

### 4. Mini-tableau de bord
Indicateurs d'un coup d'œil :
- nb de membres, nb de sessions actives ;
- nb d'alertes de terrain actives ;
- **état de la connexion ResaMania** (le compte de service fonctionne-t-il ?) ;
- **dernier passage des crons** (check-alerts, warm-planning…) + nb de notifications envoyées.

### 5. Historique des demandes + blocklist
- Historique des demandes traitées (approuvées / rejetées, date) pour la traçabilité ;
- **blocklist** d'un email pour empêcher une réinscription abusive.

### 6. Modération Tricount
Voir / clôturer / supprimer un groupe Tricount (remplace le nettoyage manuel en base).

---

## 🥉 Plus lourd / optionnel

### 7. Multi-admins gérables dans l'UI
Aujourd'hui l'admin = allowlist `ADMIN_EMAILS` (env, modifiable seulement par redéploiement de
la variable). Pour nommer/révoquer des admins depuis l'appli, ajouter une **colonne `role`**
sur `User` (petite migration). À faire seulement si on veut déléguer l'administration.

### 8. Journal d'audit
Tracer « qui a approuvé / supprimé / annoncé quoi ». Utile surtout avec plusieurs admins.

### 9. Feature flags runtime
Activer / couper une fonction sans redéploiement. Coûteux : les flags actuels sont build-time
(`NEXT_PUBLIC_*`) → il faudrait un mécanisme runtime (ex. Edge Config). Probablement pas
prioritaire.

---

## Recommandation
Commencer par **#1 (gestion des membres)** et **#2 (annonce push)** : meilleur rapport
valeur/effort, et suppriment les manipulations manuelles en base de données.

---

## Ordre d'implémentation

Ordre issu du croisement priorité × dépendances techniques réelles. Rappel des contraintes
côté code : `pushToUser` existe mais pas `pushToAll` (trivial à ajouter, 0 migration) ;
`User` n'a **ni `lastLoginAt`, ni `role`, ni champ de désactivation** (chacun = migration +
câblage dans l'auth) ; la suppression d'un membre est bloquée par des relations `Restrict`
(Tricount) → logique transactionnelle, **réutilisée** pour #6 ; bannière et flags runtime
n'ont pas de store → #3 introduit une table `AppSetting` que #9 réutilisera.

**Étape 0 — #2 Annonce push à tous** (0 migration, gain immédiat) — ✅ FAIT
Ajouter `pushToAll` + route `/api/admin/announce` + formulaire titre/message. Réutilise 100 %
l'infra push. À livrer en premier : aucun risque schéma.

**Étape 1 — #1 Gestion des membres**, en 3 sous-phases — ✅ FAIT
(migration `20_user_admin_mgmt` : `lastLoginAt` + `disabledAt` ; `src/lib/members.ts` ;
`/api/admin/members` ; page `/admin/membres`. Suppression refusée si dépendances `Restrict`
→ désactivation à la place. Désactivation révoque les sessions + refus aux deux logins.)
1. **Liste lecture seule** — migration `lastLoginAt` (+ remplissage au login), puis affichage
   (nom, email, mode, date d'inscription, dernière connexion). Sans la migration, la colonne
   « dernière connexion » reste vide.
2. **Actions non destructives** — « renvoyer un lien d'activation » / « forcer une
   réinitialisation » : réutilise directement `email-auth`, aucune migration.
3. **Destructif** — désactiver (migration `disabledAt` + refus au login), puis
   supprimer-avec-dépendances (logique transactionnelle `Restrict`). Vrai gros morceau.

**Étape 2 — #3 Bannière d'annonce** — ✅ FAIT
Introduit la table `AppSetting` (KV générique, migration `21_app_setting`). `src/lib/settings.ts`
(getBanner/setBanner/clearBanner) ; `GET /api/banner` (public) + `POST /api/admin/banner` (admin) ;
composant `AnnouncementBanner` dans le layout (masquable, réapparaît si modifiée via `version`) ;
éditeur dans la section « broadcast » de `/admin`.

**Étape 3 — #5 Historique demandes + blocklist**
Prolonge la gestion `EmailToken` (garder les demandes traitées au lieu de les supprimer) +
petite table blocklist. Naturel juste après avoir touché les demandes.

**Étape 4 — #4 Mini-tableau de bord**
Agrège les compteurs (sessions actives ← dépend du `lastLoginAt` de l'étape 1), état ResaMania,
dernier passage des crons + nb de notifs envoyées.

**Étape 5 — #6 Modération Tricount**
Réutilise la logique « suppression avec dépendances » écrite à l'étape 1.3 → quasi gratuit.

**Étape 6 — le lourd/optionnel** : #7 (colonne `role` en base) → #8 (journal d'audit) →
#9 (flags runtime).
