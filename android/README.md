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
android/build.sh      # Git Bash ; mot de passe lu dans $ANDROID_KEY_PASSWORD, sinon dans le fichier
```

Sorties (ignorées par git) :

- `app-release-signed.apk` : à installer sur un téléphone pour tester ;
- `app-release-bundle.aab` : à envoyer au Play Store.

⚠️ **Pas `bubblewrap build`.** Il passe le mot de passe en ligne de commande à `jarsigner` et
l'**affiche en clair** dans son message d'erreur au moindre échec. C'est arrivé le 11/10/2026,
et le mot de passe a été changé. `build.sh` fait la même chose (Gradle, zipalign, apksigner,
jarsigner) en lisant le mot de passe dans l'environnement.

## Tester sur un téléphone

1. Sur le téléphone : Paramètres → À propos → toucher 7 fois « Numéro de build », puis
   Options pour les développeurs → **Débogage USB**.
2. Brancher en USB, accepter l'empreinte de l'ordinateur sur le téléphone.
3. `~/.bubblewrap/android_sdk/platform-tools/adb install -r app-release-signed.apk`
4. Déboguer la page : `chrome://inspect` dans Chrome sur l'ordinateur.

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
