import type { MetadataRoute } from "next";

// Manifest PWA : rend l'appli « installable » (écran d'accueil, plein écran).
// Next l'expose automatiquement sur /manifest.webmanifest et ajoute le <link rel="manifest">.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Squash de l'Yvette",
    short_name: "Squash Yvette",
    description:
      "Planning et réservation des terrains de squash (Le Complexe, Bures)",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff", // fond blanc = se fond avec le logo (fond blanc)
    theme_color: "#0f1115",
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
    ],
  };
}
