import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import MaintenanceBanner from "@/components/MaintenanceBanner";
import AnnouncementBanner from "@/components/AnnouncementBanner";
import UpdateReloader from "@/components/UpdateReloader";
import ChunkErrorReload from "@/components/ChunkErrorReload";
import AnnounceModal from "@/components/AnnounceModal";
import FeatureProvider from "@/components/FeatureProvider";
import { getFeatures } from "@/lib/features-server";
import InstallAppPrompt from "@/components/InstallAppPrompt";
import AndroidAppPrompt from "@/components/AndroidAppPrompt";
import "@picocss/pico/css/pico.min.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Squash de l'Yvette — Réservations",
  description: "Planning et réservations de squash (Le Complexe, Bures)",
  icons: {
    icon: "/logo_squash.jpeg",
    apple: "/logo_squash.jpeg",
  },
  appleWebApp: {
    capable: true,
    title: "Squash Yvette",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1115" },
  ],
};

// Applique le thème choisi (localStorage) avant le premier rendu → pas de flash.
// Absent ou "system" → aucun attribut, Pico suit prefers-color-scheme. Les thèmes
// explicites (light/dark/rose) sont posés en data-theme dès le paint initial.
// La couleur de la barre du navigateur suit aussi le thème CHOISI (cf. lib/theme : mêmes
// valeurs, à changer ensemble).
const themeScript = `(function(){try{var t=localStorage.getItem('theme');var c={light:'#ffffff',dark:'#0f1115',rose:'#ffc9e3'}[t];if(c){document.documentElement.setAttribute('data-theme',t);var m=document.querySelectorAll('meta[name="theme-color"]');for(var i=0;i<m.length;i++){m[i].setAttribute('content',c);}}}catch(e){}})();`;

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Nonce posé par src/middleware.ts (CSP stricte). On le passe au script de thème inline
  // pour qu'il reste autorisé. Next propage ce même nonce à ses propres scripts tout seul.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  // Les flags effectifs, lus ICI plutôt que par un fetch client (audit 2026-10, point 26) : le
  // layout est déjà dynamique, et `getFeatures` ne jette jamais (repli sur l'env).
  const features = await getFeatures();
  return (
    <html lang="fr" suppressHydrationWarning>
      <body>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeScript }} />
        <ChunkErrorReload />
        <MaintenanceBanner />
        <UpdateReloader />
        <AnnouncementBanner />
        <FeatureProvider initial={features}>{children}</FeatureProvider>
        <AnnounceModal />
        <InstallAppPrompt />
        <AndroidAppPrompt />
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
