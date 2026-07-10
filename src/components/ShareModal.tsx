"use client";

import { useEffect, useRef } from "react";
import { Dialog } from "@/components/Dialog";

// Bouton « partager » : Web Share natif (mobile) sinon copie du lien.
// Partage : notre PROPRE QR code (logo raquette au centre + « Squash de l'Yvette »),
// scannable/partageable/téléchargeable. Contrairement au QR du menu natif du téléphone,
// on maîtrise ici l'icône centrale et le texte.
export function ShareModal({
  open,
  onClose,
  toast,
}: {
  open: boolean;
  onClose: () => void;
  toast: (type: "ok" | "err" | "info", msg: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // URL racine de l'appli (sans les filtres de la vue courante) → QR stable.
  const appUrl = () =>
    typeof window !== "undefined" ? `${window.location.origin}/` : "";

  useEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    (async () => {
      // QRCode chargé à la demande (seulement à l'ouverture du partage) : son JS ne pèse
      // pas sur le bundle initial de la page.
      const { default: QRCode } = await import("qrcode");
      if (cancelled) return;
      // 1) QR dans un canvas temporaire (correction d'erreurs « H » → logo central OK).
      const qr = document.createElement("canvas");
      await QRCode.toCanvas(qr, appUrl(), {
        width: 320,
        margin: 2,
        errorCorrectionLevel: "H",
        color: { dark: "#0f1115", light: "#ffffff" },
      });
      if (cancelled) return;

      // 2) Composition finale : QR + légende (fond toujours blanc pour rester scannable).
      const W = 320;
      const H = 372;
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(qr, 0, 0, 320, 320);
      ctx.fillStyle = "#0f1115";
      ctx.textAlign = "center";
      ctx.font = "600 20px system-ui, -apple-system, sans-serif";
      ctx.fillText("Squash de l'Yvette", W / 2, 352);

      // 3) Logo raquette au centre, sur une pastille blanche (préserve la lisibilité du QR).
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        const s = 86; // taille du logo central (QR en correction « H » → reste scannable)
        const x = (320 - s) / 2;
        const y = (320 - s) / 2;
        const pad = 8;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x - pad, y - pad, s + pad * 2, s + pad * 2);
        ctx.drawImage(img, x, y, s, s);
      };
      img.src = "/logo_squash.jpeg";
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(appUrl());
      toast("ok", "Lien copié ✅");
    } catch {
      toast("err", "Copie impossible");
    }
  };

  // Partage l'IMAGE du QR (menu natif si dispo), sinon la télécharge.
  const shareQr = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob(async (blob) => {
      if (!blob) return;
      const file = new File([blob], "squash-yvette-qr.png", { type: "image/png" });
      try {
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({
            files: [file],
            title: "Squash de l'Yvette",
            text: "Réserve un terrain de squash 🎾",
          });
        } else {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "squash-yvette-qr.png";
          a.click();
          URL.revokeObjectURL(a.href);
          toast("ok", "QR code téléchargé");
        }
      } catch {
        /* partage annulé par l'utilisateur */
      }
    }, "image/png");
  };

  if (!open) return null;
  return (
        <Dialog onClose={onClose} label="Partager l'appli" className="share">
            <h3>Partager l'appli</h3>
            <p className="muted tiny">
              Scanne ce QR code pour ouvrir l'appli, ou copie le lien.
            </p>
            <div className="qr-wrap">
              <canvas ref={canvasRef} className="qr-canvas" aria-label="QR code de l'appli" />
            </div>
            <div className="share-actions">
              <button onClick={shareQr}>Partager le QR</button>
              <button className="secondary" onClick={copyLink}>
                Copier le lien
              </button>
            </div>
            <div className="modal-actions">
              <button className="secondary" onClick={onClose}>
                Fermer
              </button>
            </div>
        </Dialog>
  );
}
