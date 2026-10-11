#!/usr/bin/env bash
# Construit l'APK de test et l'AAB du Play Store, signés avec la clé d'upload.
#
# POURQUOI PAS `bubblewrap build`. Il passe le mot de passe de la clé EN LIGNE DE COMMANDE à
# jarsigner, et l'affiche en clair dans son message d'erreur au moindre échec. C'est arrivé
# (jarsigner absent du PATH) et il a fallu changer le mot de passe. Ici, apksigner et jarsigner
# le lisent dans l'ENVIRONNEMENT : il n'apparaît ni dans la liste des processus, ni dans aucune
# sortie.
#
# Usage (Git Bash) :  android/build.sh
# Mot de passe : $ANDROID_KEY_PASSWORD, sinon demandé au clavier (sans écho).
set -euo pipefail
cd "$(dirname "$0")"

BW="$HOME/.bubblewrap"
KEYSTORE="${ANDROID_KEYSTORE:-$HOME/.android-keys/squash-yvette-upload.jks}"
ALIAS="upload"
TOOLS="$BW/android_sdk/build-tools/36.1.0"

# Le mot de passe vit dans un gestionnaire de mots de passe, pas sur le disque : on le demande,
# sans écho. Le fichier n'est lu que s'il existe encore (premier poste, avant rangement).
if [ -z "${ANDROID_KEY_PASSWORD:-}" ]; then
  PW_FILE="$HOME/.android-keys/squash-yvette-upload.password.txt"
  if [ -f "$PW_FILE" ]; then
    ANDROID_KEY_PASSWORD="$(cat "$PW_FILE")"
  elif [ -t 0 ]; then
    read -rsp "Mot de passe de la clé d'upload : " ANDROID_KEY_PASSWORD
    echo
  else
    echo "Mot de passe de la clé introuvable : lancer le script dans un terminal, ou définir ANDROID_KEY_PASSWORD." >&2
    exit 1
  fi
fi
export ANDROID_KEY_PASSWORD
export JAVA_HOME="$(cygpath -w "$BW/jdk")"
export ANDROID_HOME="$(cygpath -w "$BW/android_sdk")"
KS_WIN="$(cygpath -w "$KEYSTORE")"

# 1. Compilation (non signée). `./gradlew.bat` par son chemin : le terminal de Claude Code
#    interdit à cmd de lancer un exécutable du dossier courant sans chemin explicite.
./gradlew.bat assembleRelease bundleRelease --console=plain -q

# 2. APK : alignement, puis signature v2/v3 par apksigner.
"$TOOLS/zipalign.exe" -f -p 4 app/build/outputs/apk/release/app-release-unsigned.apk app-release-unsigned-aligned.apk
"$TOOLS/apksigner.bat" sign --ks "$KS_WIN" --ks-key-alias "$ALIAS" \
  --ks-pass env:ANDROID_KEY_PASSWORD --key-pass env:ANDROID_KEY_PASSWORD \
  --out app-release-signed.apk app-release-unsigned-aligned.apk
rm -f app-release-unsigned-aligned.apk

# 3. AAB : le Play Store attend une signature jarsigner.
"$BW/jdk/bin/jarsigner" -sigalg SHA256withRSA -digestalg SHA-256 -keystore "$KS_WIN" \
  -storepass:env ANDROID_KEY_PASSWORD -keypass:env ANDROID_KEY_PASSWORD \
  -signedjar app-release-bundle.aab app/build/outputs/bundle/release/app-release.aab "$ALIAS" >/dev/null

echo "APK de test   : android/app-release-signed.apk"
echo "AAB Play Store : android/app-release-bundle.aab"
