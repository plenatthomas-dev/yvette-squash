import { ImageResponse } from "next/og";

// Icône « Ajouter à l'écran d'accueil » sur iOS (PNG généré à la volée par next/og).
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#0f1115",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            width: 116,
            height: 116,
            borderRadius: 116,
            background: "#1f9d57",
            display: "flex",
          }}
        />
      </div>
    ),
    { ...size },
  );
}
