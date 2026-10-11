# Étude — passer à une vraie application Android ?

**Date :** 2026-10-11 · **Branche :** `docs/etude-app-android` · **Statut :** mise en œuvre
commencée. La TWA se construit et se signe (`android/`, cf. [android/README.md](../android/README.md)) ;
il reste à trancher le domaine, à corriger le bouton retour et à préparer la publication.

Question posée : que manque-t-il pour faire de l'appli une **application Android complète** ?
Quels logiciels, comment embarquer l'appli web actuelle, faut-il changer de base, comment
versionner, combien ça coûte ?

**Réponse courte : une TWA** (Trusted Web Activity). C'est un APK qui affiche l'appli actuelle
plein écran dans Chrome, publié sur une **piste Google Play fermée**. On ne réécrit pas l'appli
et on ne touche pas à la base. Il faut 25 $ une fois et 4 à 6 jours de travail, dont le plus
gros est le **bouton retour**. Une décision doit précéder tout le reste : **le domaine** (§5).

---

## 1. Le point de départ : c'est déjà presque une appli Android

L'appli est une PWA complète, et pas seulement en surface :

| Brique | Où | Ce qu'elle apporte |
|---|---|---|
| Manifest | `src/app/manifest.ts` | nom, icônes (dont une *maskable*), plein écran, captures |
| Service worker | `public/sw.js` | réception des notifications push, ouverture au clic |
| Invitation à installer | `src/components/InstallAppPrompt.tsx` | vrai bouton d'installation sur Chrome Android |
| Web Push (VAPID) | `src/lib/push.ts`, `src/lib/pushClient.ts` | notifications appli fermée |
| Écran allumé pendant le marquage | `src/lib/wake-lock.ts` | API Wake Lock |
| Partage de score en image | `src/components/FreeScorer.tsx` | API Web Share (fichiers) |
| Passkeys | `src/lib/webauthn.ts` | empreinte et déverrouillage du téléphone |

Point important : **installée depuis Chrome sur Android, l'appli devient déjà une WebAPK**.
Chrome fait fabriquer par Google un vrai APK signé, qui a une icône dans le tiroir
d'applications, une entrée dans « Applications » des réglages et ses propres réglages de
notification. Pour un membre qui l'a installée, il ne manque presque rien.

Ce qui manque **réellement** pour parler d'« application Android complète » :

1. **Être sur le Play Store.** C'est d'abord une question de confiance et de facilité :
   « cherche Squash Yvette sur le Store » est plus simple à dire qu'« ouvre ce lien dans
   Chrome, puis menu ⋮, puis Installer ».
2. **Le bouton retour.** Aujourd'hui, il quitte l'appli au lieu de fermer la fenêtre ouverte
   (§3.2). Dans un onglet, ça passe. Dans une appli, ça se remarque tout de suite.
3. **Des notifications au nom de l'appli**, pas de Chrome, sur tous les appareils (§3.4).

---

## 2. Trois façons de faire, comparées

| | **TWA** (Bubblewrap / PWABuilder) | **Capacitor** (WebView) | **Réécriture native** (Kotlin / React Native) |
|---|---|---|---|
| Principe | Chrome affiche le site en plein écran dans un APK | un composant WebView affiche le site dans un APK | tout l'écran est réécrit |
| Code de l'appli touché | quasi rien (§3) | adaptations, plus du code natif | ≈ 40 composants et ~18 000 lignes d'interface à refaire |
| Notifications | Web Push actuel, inchangé | **à refaire avec Firebase (FCM)** : le Web Push ne marche pas en WebView | FCM |
| Passkeys | inchangées (c'est Chrome) | configuration androidx.webkit + liens d'application | API Credential Manager |
| Connexion | cookie `sid` partagé avec Chrome | cookie propre à la WebView, reconnexion | jetons à la place du cookie |
| Mises à jour | **chaque déploiement Vercel, sans passer par le Store** | idem si l'URL est distante | une publication Store à chaque fois |
| Risque de refus au Store | faible (format promu par Google) | réel (règle « appli qui se contente d'emballer un site ») | nul |
| Effort | **≈ 4 à 6 jours** | ≈ 8 à 13 jours, plus l'entretien des plugins | 2 à 4 mois |

### Pourquoi pas Capacitor

Capacitor brille quand on **embarque** le site dans l'APK. Ici, c'est impossible : l'appli n'est
pas un site statique. Elle a 94 routes API, du rendu serveur, une CSP à nonce posée par le
middleware (`src/middleware.ts:100`) et BotID. Il faudrait donc pointer la WebView sur l'URL en
ligne. On perdrait alors l'intérêt de Capacitor et on cumulerait ses inconvénients :

- **refaire les notifications** : projet Firebase, `firebase-admin` côté serveur, une table de
  jetons FCM à côté de `PushSubscription`, un second chemin d'envoi dans `src/lib/push.ts` ;
- les passkeys en WebView, à configurer à part ;
- une session propre à la WebView, donc tout le monde se reconnecte.

### Pourquoi pas le natif

L'appli vit de ses mises à jour fréquentes (57 migrations, 26 fusions sur `main` en un mois). En natif, chaque correction passerait par la revue du Store et attendrait que chaque
membre mette à jour. On paierait des mois de réécriture pour **perdre** cette souplesse.

---

## 3. Embarquer l'appli actuelle dans une TWA

### 3.1 Comment ça marche

Un petit APK (généré, pas écrit à la main) lance Chrome en mode « Trusted Web Activity » sur
`https://squash-yvette.vercel.app/` : plein écran, sans barre d'adresse. Chrome n'accepte le
plein écran que si le **site déclare l'APK** et que l'**APK déclare le site**. C'est le rôle des
*Digital Asset Links*. Si la vérification échoue, l'appli s'ouvre avec une barre d'adresse : ça
marche toujours, c'est juste moins propre.

Conséquence : **le moteur, c'est Chrome**. Cookies, passkeys, service worker et notifications
sont ceux du Chrome du téléphone. Un membre déjà connecté dans Chrome l'est aussi dans l'appli.

### 3.2 Ce qu'il faut changer côté web

| Changement | Pourquoi | Effort |
|---|---|---|
| `public/.well-known/assetlinks.json` | la moitié « site » des Digital Asset Links : nom du package et empreintes SHA-256 de la clé de signature Play **et** de la clé d'upload. Le middleware le laisse passer (il n'y ajoute qu'un en-tête CSP, sans effet sur du JSON ; cf. `src/middleware.ts:123`). | 1 h |
| **Bouton retour** | voir ci-dessous | **1 à 2 j** |
| Masquer `InstallAppPrompt` dans l'appli | proposer d'« installer l'appli » à quelqu'un qui est déjà dedans. On reconnaît la TWA à son référent `android-app://<package>/` au lancement, à mémoriser pour la session. | 2 h |
| Badge de notification monochrome | `public/sw.js:36` utilise `logo_squash.jpeg` : Android ne garde que la transparence d'un badge, donc un JPEG devient un **carré blanc** dans la barre d'état. Il faut un PNG silhouette sur fond transparent. Le défaut existe déjà aujourd'hui. | 1 h |
| Raccourcis dans le manifest | `shortcuts` (Planning, Interclub) : appui long sur l'icône. Optionnel. | 1 h |

**Le bouton retour, en détail.** L'appli ne crée aucune entrée d'historique. Elle ne fait que
des `replaceState` (`src/app/page.tsx:649`, `src/components/AnnounceModal.tsx:27`,
`src/components/LoginScreen.tsx:158`). Dans une TWA, le geste retour d'Android est un
`history.back()`, et sans historique il **ferme l'appli**. Un membre qui ouvre la fiche d'une
rencontre puis fait « retour » se retrouve donc sur l'écran d'accueil du téléphone.

La correction : un `pushState` à chaque changement de vue et à chaque ouverture de modale, et
un gestionnaire `popstate` qui referme la modale ou revient à la vue précédente. C'est le seul
vrai chantier de code. Il profite aussi à la PWA installée d'aujourd'hui, qui a exactement le
même défaut.

### 3.3 Ce qui ne bouge pas

CSP, Pusher (fil en temps réel), BotID, wake lock, partage, Vercel Analytics, passkeys (même
domaine, donc même rpID), sessions. Les liens des e-mails (réinitialisation du mot de passe)
s'ouvriront dans l'appli grâce aux *App Links*, déclarés par le même `assetlinks.json`.

### 3.4 Les notifications

La TWA active la **délégation de notifications** : les push reçus par Chrome pour ce site
s'affichent au nom de l'appli, avec ses propres réglages Android. Depuis Android 13, l'appli
doit détenir la permission `POST_NOTIFICATIONS`. Bubblewrap la déclare (`enableNotifications`),
et l'appel `Notification.requestPermission()` de `ensurePushSubscribed` (`src/lib/pushClient.ts`)
déclenche la demande Android. **À valider sur un vrai téléphone Android 13+** (§11). Côté
serveur, rien ne change : VAPID et la table `PushSubscription` restent tels quels.

---

## 4. La base de données : on ne change rien

L'appli Android est un **client de plus** de la même origine. Elle appelle les mêmes routes
`/api/*`, qui parlent à la même base :

- **Prisma + Postgres (Neon)** : inchangés, tout comme les migrations jouées au build (cf.
  [flux-branches.md](flux-branches.md)).
- **Pas de base locale ni de mode hors ligne.** `public/sw.js` n'a volontairement aucun cache.
  Surtout, la source de vérité des réservations est **ResaMania**, pas nous : « réserver hors
  ligne » n'aurait pas de sens, et une base SQLite synchronisée sur le téléphone ajouterait des
  conflits à résoudre pour rien.
- **La charge ne change pas** : mêmes membres, mêmes requêtes. Les CU-hours Neon, le seul
  plafond qui ait jamais posé problème (cf. [etude-migration-supabase.md](etude-migration-supabase.md)),
  ne bougent pas.

Même la réécriture native garderait Postgres derrière les mêmes routes API. La question de la
base ne se pose dans aucun des scénarios.

---

## 5. Le domaine : à trancher AVANT de publier

L'adresse `squash-yvette.vercel.app` va être **gravée dans l'appli** :

- dans l'APK (URL de lancement, domaine vérifié) ;
- dans les sessions (cookies attachés au domaine) ;
- dans les passkeys, liées au domaine (`src/lib/webauthn.ts:13` le dit en toutes lettres).

Passer plus tard à un domaine à nous (`squash-yvette.fr`, par exemple) imposerait de publier une
nouvelle version de l'appli, déconnecterait tout le monde et **invaliderait tous les passkeys**.

Les choix possibles :

| | Coût | Pour | Contre |
|---|---|---|---|
| **A. Domaine perso** (ex. `squash-yvette.fr`, chez OVH, Gandi ou Vercel Domains) | ≈ 7-12 €/an | l'adresse ne dépend plus de Vercel ; permet d'envoyer les e-mails depuis `@squash-yvette.fr` (SPF/DKIM, moins de spam) | une reconnexion pour chacun lors de la bascule ; passkeys à refaire (aucun si la biométrie est restée coupée en prod) |
| **B. Garder `squash-yvette.vercel.app`** | 0 € | rien à faire | « vercel » dans l'adresse ; elle change si le projet Vercel est renommé ou transféré (au club, par exemple), ce qui imposerait une nouvelle version de l'appli |
| **C. Sous-domaine du site du club** (ex. `app.<site-du-club>.fr`) | 0 € | institutionnel | il faut que la personne qui gère le domaine du club ajoute une entrée DNS ; on dépend d'elle |

**Recommandation : A, ou C si l'association a déjà un domaine.** Dans les deux cas : brancher le
domaine sur Vercel, rediriger l'ancienne adresse vers la nouvelle, laisser passer quelques
semaines, et seulement **ensuite** publier l'appli.

**Décision au 11/10/2026 : reportée.** La TWA est construite sur `squash-yvette.vercel.app`.
Changer d'adresse reste gratuit tant que l'appli n'est pas sur le Play Store : un champ de
`android/twa-manifest.json` et une régénération (cf. `android/README.md`). Ce qu'il faut
éviter, c'est publier maintenant et changer de domaine dans six mois.

---

## 6. Versionning et flux de branches

### Le web : rien ne change

`package.json` donne la version affichée en pied de page (`v2.0`, cf. `next.config.mjs`) et
`BUILD_ID` alimente le rechargement après un déploiement. **Chaque déploiement Vercel met l'app
Android à jour instantanément**, sans passer par le Store. C'est l'argument principal de la TWA.

### L'enveloppe Android : rarement touchée

- Elle vit dans le dépôt, dans un dossier `android/` : `twa-manifest.json` (la configuration
  Bubblewrap) et le projet Gradle généré. Un seul dépôt, une seule histoire.
- `versionCode` : un entier, incrémenté à **chaque** envoi au Play Store. `versionName` est
  libre (`1.0`, `1.1`…), indépendant de la version web.
- On republie l'APK seulement si :
  - le nom, l'icône, les couleurs ou les raccourcis changent ;
  - Google relève le niveau d'API exigé, **une fois par an**. Depuis le 31/08/2026, toute mise à
    jour doit cibler Android 16 (API 36), et une appli qui ne suit pas cesse d'être proposée
    aux nouveaux utilisateurs.
- **Signature** : *Play App Signing* (Google garde la clé de l'appli) + une **clé d'upload** à
  nous. Elle n'est **jamais commitée** (`.gitignore`) et elle est sauvegardée (gestionnaire de
  mots de passe). La perdre n'est pas fatal avec Play App Signing, mais la réinitialiser passe
  par le support de Google.

### Recette et pistes de test

- **Recette** : pas d'appli dédiée au départ, on continue de tester dans Chrome sur l'URL de
  recette. Plus tard, un second package (`…recette`) pointant sur l'URL de la branche `Recette`
  est possible : le même `assetlinks.json`, servi par le même code, peut déclarer les deux.
- **Pistes Google Play** : *interne* (jusqu'à 100 testeurs, disponible en quelques minutes),
  puis *fermée* (sur invitation, sans plafond pratique), puis *production* (publique).
- **CI** : facultative. Une GitHub Action pourrait construire l'AAB sur un tag `android-v*` et
  l'envoyer à Play. Vu la rareté des publications, une construction à la main suffit au début.

---

## 7. Logiciels à installer (poste Windows)

| Outil | Rôle | Remarque |
|---|---|---|
| Node.js | déjà là | |
| **JDK 17** | compiler l'APK | Bubblewrap propose de l'installer lui-même |
| **Android SDK** (outils en ligne de commande) | idem | Bubblewrap propose de l'installer lui-même |
| **Bubblewrap** (`npm i -g @bubblewrap/cli`) | génère et construit la TWA depuis le manifest | `bubblewrap init --manifest=https://squash-yvette.vercel.app/manifest.webmanifest` puis `bubblewrap build` |
| *ou* **PWABuilder.com** | même résultat, dans le navigateur | ne demande **rien** d'installé ; fournit l'AAB, la clé et l'`assetlinks.json` |
| Android Studio | facultatif | émulateur, journaux (logcat) |
| Un téléphone Android | indispensable pour tester | débogage USB, `adb`, `chrome://inspect` |
| Compte Google Play Console | publier | §8 |

---

## 8. Publier sur le Play Store

### Le compte

- **25 $, une seule fois**, plus une vérification d'identité.
- **Compte personnel** (à ton nom) : s'il a été créé après le 13/11/2023, il doit d'abord mener
  un **test fermé avec au moins 12 testeurs pendant 14 jours d'affilée** avant d'accéder à la
  production publique. Les testeurs ne manquent pas dans un club.
- **Compte organisation** (l'association) : exempté de cette règle, et la fiche affiche le nom
  du club. Il faut un numéro **D-U-N-S** (gratuit, mais quelques jours à quelques semaines pour
  l'obtenir) et des documents de l'association.

### Ce que Google exige de la fiche

| Exigence | État aujourd'hui | À faire |
|---|---|---|
| Icône 512 px, bannière 1024×500, captures | icône et captures déjà dans `public/` | la bannière |
| **Politique de confidentialité à une URL publique** | `PrivacyNotice` est une fenêtre **dans** l'appli | une page publique (`/confidentialite`) qui en reprend le texte |
| Formulaire *Data safety* | | déclarer : e-mail, nom, identifiants ResaMania (chiffrés), réservations, abonnements push… |
| Classification du contenu, public visé | | questionnaires en ligne |
| **Suppression de compte** dans l'appli **et** par une URL web | on peut seulement « demander » (`src/components/PrivacyNotice.tsx:430`) | au minimum une page web de demande de suppression ; idéalement un bouton dans les Paramètres |

### Le risque ResaMania

L'appli utilise **l'API interne de ResaMania avec le compte de chaque joueur**. Le README
prévient que ça peut être contraire à leurs CGU. Une fiche **publique** sur le Play Store
donne une visibilité que l'appli n'a pas aujourd'hui, et une plainte de leur part pourrait
faire retirer l'appli. D'où la recommandation :

- **rester sur une piste fermée**, où les membres sont invités par e-mail ou par un Google
  Group. L'appli ne serait alors jamais publique, la règle des 12 testeurs ne s'appliquerait
  pas (elle ne vise que l'accès à la production), et l'expérience serait la même pour les
  membres une fois invités ;
- ne citer ni la marque ni le logo ResaMania dans la fiche.

### Et sans le Play Store ?

Distribuer l'APK à la main (lien de téléchargement) est possible, mais **déconseillé** :
autoriser les « sources inconnues » n'est pas un geste pour des membres peu technophiles. Et
Google étend la **vérification obligatoire des développeurs** aux applis installées hors Store :
en vigueur depuis le 30/09/2026 au Brésil, en Indonésie, à Singapour et en Thaïlande, mondiale
en 2027. Elle prévoit des comptes « distribution limitée » (jusqu'à 20 appareils) et un parcours
d'installation avancé. Ça complique encore la voie manuelle.

---

## 9. Les coûts

| Poste | Coût |
|---|---|
| Compte Google Play Console | **25 $ une fois** |
| Domaine perso (facultatif, §5) | ≈ 10-15 €/an |
| Hébergement (Vercel Hobby + Neon gratuit) | **inchangé** : l'appli n'ajoute aucune charge serveur |
| Outils (Bubblewrap, JDK, SDK, Android Studio) | gratuits |
| Firebase | 0 € (inutile en TWA) |

**Temps de travail estimé pour la TWA :**

| Étape | Temps |
|---|---|
| Bouton retour (historique + `popstate`) et ses tests | 1 à 2 j |
| Pages publiques confidentialité + suppression de compte | 1 à 1,5 j |
| `assetlinks.json`, génération et signature de la TWA, essai sur téléphone | 0,5 à 1 j |
| Badge, `InstallAppPrompt`, raccourcis | 0,5 j |
| Fiche Play, Data safety, questionnaires | 0,5 j |
| **Total** | **≈ 4 à 6 jours** |

Il faut y ajouter **14 jours de calendrier** de test fermé si l'on vise un jour la production
publique avec un compte personnel.

**À titre de comparaison :** Capacitor demanderait 4 à 7 jours de plus (FCM, passkeys en
WebView), puis l'entretien de ses plugins. Le natif demanderait 2 à 4 mois. **iOS** est un autre
sujet : la TWA n'existe pas sur iPhone, il faudrait Capacitor ou rester en PWA, et compter
99 $/an pour le compte Apple plus un Mac pour construire l'appli.

---

## 10. Feuille de route proposée

1. **Trancher le domaine** (§5). Si c'est un domaine perso, le mettre en place d'abord et laisser
   passer quelques semaines.
2. **Bouton retour** : utile dès aujourd'hui pour la PWA installée, indispensable pour l'appli.
3. **Badge monochrome** : défaut actuel, une heure de travail.
4. **Pages publiques** de confidentialité et de suppression de compte.
5. **Compte Play Console** : personnel ou association (décision à prendre avec le bureau).
6. **TWA** : `bubblewrap init` → `assetlinks.json` → essai sur téléphone → piste **interne**
   avec 2 ou 3 testeurs.
7. **Piste fermée** ouverte aux membres. On s'arrête là tant que le risque ResaMania n'est pas
   levé.

---

## 11. À revérifier au moment de faire

Les règles des stores bougent vite. Ce qui suit a été vérifié en octobre 2026, mais doit être
confirmé à la source le jour venu :

- **Règle des 12 testeurs / 14 jours** : relevée sur des sites tiers, **pas** sur l'aide
  officielle de Google. Vérifier la page « exigences de test » dans Play Console.
- **Calendrier de vérification des développeurs pour la France** (annoncé pour 2027, sans date
  précise).
- **La demande de permission des notifications** dans une TWA générée par Bubblewrap, sur un
  téléphone Android 13+ réel : c'est le point le moins documenté.
- **Reconnaître la TWA** (référent `android-app://`, ou `display-mode`) : à tester avant de
  masquer `InstallAppPrompt`.

### Sources

- [Exigence de niveau d'API cible — Android Developers](https://developer.android.com/google/play/requirements/target-sdk)
- [Exigences de niveau d'API cible — aide Play Console](https://support.google.com/googleplay/android-developer/answer/11926878?hl=en-419)
- [Règle des 12 testeurs — Testers Community](https://www.testerscommunity.com/guides/how-many-testers-do-you-need-google-play)
- [Règle des 12 testeurs — Choicely](https://www.choicely.com/blog/google-play-12-tester-rule)
- [Calendrier de la vérification des développeurs — Android Authority](https://www.androidauthority.com/android-sideloading-changes-timeline-3679204/)
- [Première vague de la vérification — Android Authority](https://androidauthority.com/android-sideloading-developer-verification-first-wave-rollout-3717921)
- [Délégation des notifications TWA — `TrustedWebActivityService`](https://developer.android.com/reference/androidx/browser/trusted/TrustedWebActivityService)
