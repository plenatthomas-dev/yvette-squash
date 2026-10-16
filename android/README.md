# 📱 Application Android (TWA)

L'appli Android n'est **pas** une seconde appli : c'est Chrome qui affiche
`https://squash-yvette.vercel.app/` en plein écran dans un APK (une *Trusted Web Activity*).
Chaque déploiement Vercel met donc l'appli à jour, sans passer par le Play Store. Le pourquoi
de ce choix se trouve dans [docs/etude-app-android.md](../docs/etude-app-android.md).

Ce dossier est **généré par [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap)** à
partir d'un seul fichier qu'on édite à la main : **`twa-manifest.json`**. Tout le reste
(`app/`, Gradle, icônes) se régénère avec `bubblewrap update`. Il ne faut pas le retoucher à
la main : la prochaine régénération effacerait la modification.

| | |
|---|---|
| Package (définitif dès le premier envoi au Play Store) | `fr.squashyvette.app` |
| Adresse ouverte | `squash-yvette.vercel.app` (**provisoire**, cf. « Changer de domaine ») |
| Cible | Android 16 (API 36), exigée par Google Play depuis le 31/08/2026 |
| Minimum | Android 7 (API 24), imposé par la bibliothèque TWA de Google |
| Notifications | déléguées à l'appli (`enableNotifications`), avec la permission Android 13+ |

## Les outils (installés une fois, hors du dépôt)

Tout est installé dans le dossier utilisateur, sans droits administrateur :

| Outil | Emplacement |
|---|---|
| JDK 17 (Temurin) | `~/.bubblewrap/jdk` |
| SDK Android (cmdline-tools, build-tools 36.1.0, plateforme 36, adb) | `~/.bubblewrap/android_sdk` |
| Configuration Bubblewrap | `~/.bubblewrap/config.json` |
| Bubblewrap | `npm i -g @bubblewrap/cli@1.25.0` |

⚠️ Bubblewrap cherche `bin/` à la **racine** du SDK, alors que Google range les outils sous
`cmdline-tools/latest/`. Deux jonctions (`android_sdk/bin` et `android_sdk/lib`) pointent vers
le vrai dossier. Sans elles : « The provided androidSdk isn't correct ».

## La clé de signature — À METTRE EN LIEU SÛR

La **clé d'upload** signe ce qu'on envoie au Play Store. Google re-signe ensuite avec sa propre
clé (*Play App Signing*).

- Fichier : `~/.android-keys/squash-yvette-upload.jks` (alias `upload`)
- Mot de passe : `~/.android-keys/squash-yvette-upload.password.txt`. **Le copier dans un
  gestionnaire de mots de passe, puis supprimer le fichier.**
- **Sauvegarder le `.jks`** ailleurs que sur ce poste. Avec Play App Signing, sa perte n'est
  pas fatale, mais la réinitialiser passe par le support de Google.
- Empreinte SHA-256 :
  `E5:57:DE:AB:26:6D:EA:2F:60:A9:0C:68:70:A2:D4:DA:14:36:AD:93:B3:D0:9E:F4:34:FA:FC:9C:5C:B0:38:D6`

Jamais dans le dépôt : `.gitignore` refuse `*.jks` et `*.keystore` par précaution.

## Le lien site ↔ appli (`assetlinks.json`)

Chrome n'ouvre l'appli en plein écran (sans barre d'adresse) que si le site **déclare** l'appli.
C'est `public/.well-known/assetlinks.json`, servi à
`https://squash-yvette.vercel.app/.well-known/assetlinks.json`. Il liste les empreintes des
clés qui signent l'APK :

1. **aujourd'hui** : la clé d'upload, celle des APK construits sur ce poste ;
2. **après le premier envoi au Play Store** : ajouter l'empreinte de la clé *Play App Signing*
   (Play Console → Configuration → Intégrité de l'appli). Sans elle, l'appli installée depuis le
   Store s'ouvrira **avec** une barre d'adresse.

Le fichier n'agit qu'une fois **déployé en production**. Tant qu'il ne l'est pas, l'APK de test
marche mais affiche la barre d'adresse.

## Construire

```bash
android/build.sh      # Git Bash ; demande le mot de passe de la clé (sans écho)
```

Le mot de passe vient du gestionnaire de mots de passe : le script le demande au clavier, ou le
lit dans `$ANDROID_KEY_PASSWORD`. Ne jamais le coller dans une conversation ni dans une commande.

Sorties (ignorées par git) :

- `app-release-signed.apk` : à installer sur un téléphone pour tester ;
- `app-release-bundle.aab` : à envoyer au Play Store.

⚠️ **Pas `bubblewrap build`.** Il passe le mot de passe en ligne de commande à `jarsigner` et
l'**affiche en clair** dans son message d'erreur au moindre échec. C'est arrivé le 11/10/2026,
et le mot de passe a été changé. `build.sh` fait la même chose (Gradle, zipalign, apksigner,
jarsigner) en lisant le mot de passe dans l'environnement.

## Distribuer l'APK (Releases GitHub)

Sur Android, la bannière d'installation propose l'APK, et non plus la PWA : dans un onglet
(arrivée par le QR code) comme dans la PWA déjà installée, à qui elle demande ensuite de la
supprimer (`src/components/AndroidAppPrompt.tsx`).

Le lien est `/squash-yvette.apk`, sur notre domaine : la route relaie la dernière Release,
`https://github.com/plenatthomas-dev/yvette-squash/releases/latest/download/squash-yvette.apk`,
et le CDN de Vercel garde le fichier une heure. Ça ne marche que si **l'APK garde ce nom** d'une
version à l'autre.

⚠️ Ne pas donner le lien github.com aux membres. Le 16/10/2026, sur un Pixel 8a où l'appli GitHub
est installée, elle a réclamé ce lien (elle se déclare pour tout github.com) et l'a ouvert dans sa
petite fenêtre Chrome, où le téléchargement est resté bloqué à 100 %.

Nouvelle version (après `bubblewrap update`, qui incrémente `appVersionCode`, puis `build.sh`) :

```bash
cp android/app-release-signed.apk /tmp/squash-yvette.apk
gh release create android-v<versionName> /tmp/squash-yvette.apk --target main --latest \
  --title "Appli Android <versionName>" --notes "…"
```

Première version : `android-v1.0.0` (versionCode 1), publiée le 16/10/2026.

⚠️ Cet APK est signé avec la **clé d'upload**, la version du Play Store le sera avec la clé
*Play App Signing*. Android refuse une mise à jour signée par une autre clé : un membre qui a
installé l'APK devra le désinstaller avant de prendre celle du Store.

## Tester sur un téléphone

1. Sur le téléphone : Paramètres → À propos → toucher 7 fois « Numéro de build », puis
   Options pour les développeurs → **Débogage USB**.
2. Brancher en USB, accepter l'empreinte de l'ordinateur sur le téléphone.
3. `~/.bubblewrap/android_sdk/platform-tools/adb install -r app-release-signed.apk`
4. Déboguer la page : `chrome://inspect` dans Chrome sur l'ordinateur.

**Plein écran sans déployer `assetlinks.json`.** Sur le téléphone, `chrome://flags` → « Enable
command line on non-rooted devices », puis :

```bash
adb shell "echo '_ --disable-digital-asset-link-verification-for-url=\"https://squash-yvette.vercel.app\"' > /data/local/tmp/chrome-command-line"
adb shell am force-stop com.android.chrome
```

(Depuis Git Bash, préfixer par `MSYS_NO_PATHCONV=1`, sinon `/data/…` devient un chemin Windows.)
Désactiver le flag après les tests.

### Les notifications ne passent pas par l'appli si la PWA est installée

Constaté le 11/10/2026 sur un Pixel 8a : la notification « Tester » est arrivée par la **PWA**
(`org.chromium.webapk…`) installée depuis Chrome, pas par l'appli. Chrome confie les
notifications d'un site à la WebAPK qui le couvre. Deux conséquences :

- pour tester l'icône et le nom de l'appli dans une notification, **désinstaller la PWA** et
  attendre que `assetlinks.json` soit en production. Le flag de test ne suffit pas à enregistrer
  la délégation des notifications ;
- un membre qui a déjà la PWA et installe l'appli du Store continuera de recevoir les
  notifications par la PWA tant qu'il ne l'a pas désinstallée. Il faudra le lui dire.

Chrome affiche aussi une notification silencieuse « En cours d'exécution dans Chrome » : c'est
l'avertissement standard des TWA, on ne peut pas le retirer.

## L'icône de notification

`ic_notification_icon.png` est une silhouette blanche sur fond transparent : Android n'affiche
que la transparence de cette icône, et le logo couleur y devenait un carré blanc. Sa source est
`public/icon-monochrome.svg`, déclinée en `public/icon-monochrome-512.png` (lue par Bubblewrap
via `monochromeIconUrl`) et en `public/icon-monochrome-96.png` (badge des notifications web,
`public/sw.js`).

⚠️ `bubblewrap update` **télécharge** `monochromeIconUrl` depuis la production : il échouera
tant que `icon-monochrome-512.png` n'y est pas déployé.

## Les raccourcis (appui long sur l'icône)

Planning, Interclub et Frais ouvrent directement leur vue (`/?view=…`). Ils sont déclarés deux
fois : dans `src/app/manifest.ts` pour la PWA, et dans `twa-manifest.json` (`shortcuts`) pour
l'appli. `src/app/manifest.test.ts` échoue si les deux divergent. Les icônes viennent de
`public/shortcut-*.svg`, rendues en `public/shortcut-*-192.png`.

⚠️ Comme pour l'icône de notification, `bubblewrap update` **télécharge** ces PNG depuis la
production : déployer d'abord, régénérer ensuite.

## Modifier l'appli Android

Seulement pour ce qui vit dans l'APK : nom, icône, couleurs, raccourcis, adresse. Le contenu,
lui, se modifie dans le site.

1. Éditer `twa-manifest.json`.
2. `bubblewrap update` : régénère le projet **et** incrémente `appVersionCode`, qui doit
   augmenter à chaque envoi au Play Store. `--skipVersionUpgrade` pour régénérer sans changer
   de version.
3. `android/build.sh`, puis commit de `twa-manifest.json` et du projet régénéré.

Une fois par an, Google relève le niveau d'API exigé. Mettre Bubblewrap à jour, puis
`bubblewrap update` et `build.sh` suffisent en général.

## Changer de domaine (tant que l'appli n'est pas publiée)

L'adresse est provisoire, en attendant la décision sur le domaine (§5 de l'étude). **Avant** le
premier envoi au Play Store, en changer ne coûte rien :

1. dans `twa-manifest.json`, remplacer `squash-yvette.vercel.app` partout (`host`, `iconUrl`,
   `maskableIconUrl`, `webManifestUrl`, `fullScopeUrl`) ;
2. `bubblewrap update --skipVersionUpgrade`, puis `android/build.sh` ;
3. rien à faire pour `assetlinks.json` : le même fichier est servi par le nouveau domaine.

**Après** publication, l'ancien domaine resterait inscrit dans les appareils des membres. Il
faudrait publier une mise à jour, et les sessions et passkeys seraient perdus.
