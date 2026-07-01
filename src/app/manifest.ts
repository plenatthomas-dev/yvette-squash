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
    background_color: "#0f1115",
    theme_color: "#0f1115",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}
