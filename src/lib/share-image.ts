// Partager une IMAGE fabriquée au canvas — le score d'un match libre, la feuille d'une rencontre.
//
// Dans l'ordre :
//
//  1. feuille de partage du système avec le PNG (téléphones : WhatsApp, SMS, Messages…) ;
//  2. sinon, téléchargement du PNG (ordinateur sans partage de fichiers) ;
//  3. sinon — pas de canvas du tout — le texte, partagé ou copié.
//
// L'image est fabriquée SANS `await` avant `navigator.share` : Safari iOS n'autorise le partage
// que dans la foulée du geste (cf. `lib/score-image.ts`). Une annulation par l'utilisateur
// n'est pas une erreur et ne dit rien.

type Toast = (type: "ok" | "err" | "info", msg: string) => void;

/** Partage en TEXTE : feuille de partage du système, sinon presse-papier. Le repli ultime. */
export async function shareText(text: string, toast: Toast) {
  try {
    if (typeof navigator.share === "function") {
      await navigator.share({ text });
      return;
    }
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return;
    // Partage refusé (contexte non sécurisé, permission) : on tente la copie.
  }
  try {
    await navigator.clipboard.writeText(text);
    toast("ok", "Résultat copié");
  } catch {
    toast("err", "Partage impossible sur cet appareil");
  }
}

/** Enregistre le fichier sur l'appareil (ordinateur sans partage de fichiers). */
function download(file: File) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Laisse au navigateur le temps de lancer le téléchargement avant de libérer l'URL.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * `make` fabrique le PNG, ou rend `null` sans canvas. `text` est le repli, `saved` le message
 * du téléchargement (« Image du score enregistrée »).
 */
export async function shareImage(
  make: () => File | null,
  { text, saved }: { text: string; saved: string },
  toast: Toast,
) {
  let file: File | null = null;
  try {
    file = make();
  } catch {
    file = null; // canvas refusé (mémoire, navigateur ancien) : repli sur le texte
  }
  if (file) {
    if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
        // Partage de fichier refusé : on retombe sur le téléchargement.
      }
    }
    download(file);
    toast("ok", saved);
    return;
  }
  await shareText(text, toast);
}
