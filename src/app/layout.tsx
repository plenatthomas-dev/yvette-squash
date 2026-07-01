import type { Metadata, Viewport } from "next";
import "@picocss/pico/css/pico.min.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Squash de l'Yvette — Réservations",
  description: "Planning et réservations de squash (Le Complexe, Bures)",
  icons: { icon: "/icon.svg" },
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
// Absent ou "system" → aucun attribut, Pico suit prefers-color-scheme.
const themeScript = `(function(){try{var t=localStorage.getItem('theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fr" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        {children}
      </body>
    </html>
  );
}
