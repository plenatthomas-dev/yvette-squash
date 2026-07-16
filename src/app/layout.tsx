import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import AnnouncementBanner from "@/components/AnnouncementBanner";
import AnnounceModal from "@/components/AnnounceModal";
import FeatureProvider from "@/components/FeatureProvider";
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
const themeScript = `(function(){try{var t=localStorage.getItem('theme');if(t==='light'||t==='dark'||t==='rose'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Nonce posé par src/middleware.ts (CSP stricte). On le passe au script de thème inline
  // pour qu'il reste autorisé. Next propage ce même nonce à ses propres scripts tout seul.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="fr" suppressHydrationWarning>
      <body>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeScript }} />
        <AnnouncementBanner />
        <FeatureProvider>{children}</FeatureProvider>
        <AnnounceModal />
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
