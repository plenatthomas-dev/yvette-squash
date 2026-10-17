"use client";

import { useState } from "react";
import dynamic from "next/dynamic";

const PrivacyDialog = dynamic(() => import("./PrivacyDialog"), { ssr: false });

// Le texte de la note vit dans `PrivacyDialog`, chargé au premier clic (audit 2026-10, point 27).

// Version affichée à côté de la note, sous la forme courte « v2.0 » (MAJEUR.MINEUR, calculé
// depuis package.json — cf. next.config.mjs). Elle sert à UNE chose : qu'un membre qui signale
// un souci puisse dire où il en est, sans avoir à décrire son navigateur. D'où le pied de page,
// présent sur la connexion comme sur l'appli, et le ton volontairement muet (gris, petit) —
// c'est une information de dépannage, pas un élément d'interface.
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "";

// Identifiant du build qui a produit CETTE page — inliné à la compilation, donc figé dans le
// JS que le navigateur exécute réellement. C'est la donnée qui manquait pour départager
// « le correctif n'est pas bon » de « cet onglet tourne encore sur l'ancien build » :
// /api/version répond, lui, l'identifiant du SERVEUR, et les deux diffèrent précisément dans
// le cas qu'on cherche à diagnostiquer. Affiché dans l'infobulle de la version, pas à l'écran.
const BUILD_ID = (process.env.NEXT_PUBLIC_BUILD_ID ?? "").slice(0, 7);

// Icône « information » (cercle + i) — ouvre la note de confidentialité.
export function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <line x1="12" y1="8" x2="12" y2="8" />
    </svg>
  );
}

// Pied de page : petite note « Confidentialité & données » (obligation d'information RGPD).
// Placée en bas de page (convention pour ce type de mention), sur l'écran de connexion
// comme sur l'appli. La modale réutilise le style .modal existant.
export function PrivacyNotice() {
  const [open, setOpen] = useState(false);
  return (
    <footer className="app-footer">
      <button
        type="button"
        className="footer-info"
        onClick={() => setOpen(true)}
        aria-label="Confidentialité et données"
        title="Confidentialité et données"
      >
        <InfoIcon />
        <span>Confidentialité &amp; données</span>
      </button>
      {APP_VERSION && (
        <span
          className="footer-version"
          title={
            `Version ${APP_VERSION} de l'application` +
            (BUILD_ID ? ` · build ${BUILD_ID} (celui de cette page)` : "")
          }
        >
          v{APP_VERSION}
        </span>
      )}
      {open && <PrivacyDialog onClose={() => setOpen(false)} />}
    </footer>
  );
}
