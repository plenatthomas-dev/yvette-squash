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
    icons: [
      {
        src: "/logo_squash.jpeg",
        sizes: "512x512",
        type: "image/jpeg",
        purpose: "any",
      },
      {
        src: "/logo_squash.jpeg",
        sizes: "192x192",
        type: "image/jpeg",
        purpose: "any",
      },
    ],
  };
}
