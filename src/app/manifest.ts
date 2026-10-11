import type { MetadataRoute } from "next";

// Manifest PWA : rend l'appli « installable » (écran d'accueil, plein écran).
// Next l'expose automatiquement sur /manifest.webmanifest et ajoute le <link rel="manifest">.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Squash de l'Yvette",
    short_name: "Squash Yvette",
    description:
      "Planning et réservation des terrains de squash (Le Complexe, Bures)",
    id: "/", // identité d'appli stable (sinon Chrome déduit depuis start_url)
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff", // fond blanc = se fond avec le logo (fond blanc)
    theme_color: "#0f1115",
    // Captures d'écran → débloque la « Richer PWA Install UI » de Chrome (aperçu de l'appli
    // dans la popup d'installation). Une `wide` (desktop) + une non-`wide` (mobile), comme
    // l'exige Chrome pour couvrir les deux form factors.
    screenshots: [
      {
        src: "/screenshot-wide.png",
        sizes: "2560x1600",
        type: "image/png",
        form_factor: "wide",
        label: "Planning des terrains de squash sur ordinateur",
      },
      {
        src: "/screenshot-mobile.png",
        sizes: "780x1688",
        type: "image/png",
        form_factor: "narrow",
        label: "Réservation depuis le téléphone",
      },
    ],
    // Icônes en PNG (format le plus fiable pour l'installabilité Chrome ; le JPEG passait mal).
    // Une icône « maskable » en plus → Android peut la rogner (cercle/goutte) sans couper le logo.
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
      // Silhouette blanche sur fond transparent : icônes « thématiques » d'Android 13+, et
      // source de l'icône de notification de l'appli Android (cf. android/twa-manifest.json).
      {
        src: "/icon-monochrome-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "monochrome",
      },
    ],
    // Appui long sur l'icône : ouvre directement une vue. Repris tels quels par l'appli
    // Android (android/twa-manifest.json) ; ses icônes doivent donc être EN PRODUCTION avant
    // un `bubblewrap update`. Une vue coupée (Frais, Interclub) retombe sur le planning.
    shortcuts: [
      raccourci("Planning", "Planning des terrains", "/?view=day", "planning"),
      raccourci("Interclub", "Rencontres et disponibilités", "/?view=interclub", "interclub"),
      raccourci("Frais", "Frais partagés", "/?view=money", "frais"),
    ],
  };
}

// Même image pour les deux usages : fond plein, dessin dans la zone sûre d'une icône
// maskable, si bien qu'Android peut la rogner en cercle sans rien couper.
function raccourci(name: string, description: string, url: string, icone: string) {
  const src = `/shortcut-${icone}-192.png`;
  return {
    name,
    description,
    url,
    icons: [
      { src, sizes: "192x192", type: "image/png", purpose: "any" as const },
      { src, sizes: "192x192", type: "image/png", purpose: "maskable" as const },
    ],
  };
}
