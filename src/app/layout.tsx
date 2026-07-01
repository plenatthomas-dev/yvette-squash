import type { Metadata, Viewport } from "next";
import "@picocss/pico/css/pico.min.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Yvette Squash — Réservations",
  description: "Planning et réservations de squash (Le Complexe Bures)",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0f1115",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fr" data-theme="dark">
      <body>{children}</body>
    </html>
  );
}
