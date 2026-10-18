import type { Metadata } from "next";
import Link from "next/link";
import { PrivacyContent } from "@/components/PrivacyContent";

// Page PUBLIQUE de la politique de confidentialité : /confidentialite.
//
// Google Play exige une politique de confidentialité à une URL publique, lisible sans compte ni
// appli (cf. docs/etude-app-android.md §8). Le texte est EXACTEMENT celui de la note
// « Confidentialité & données » de l'appli (`PrivacyContent`), y compris ses paragraphes
// conditionnés par les flags : la page décrit l'appli telle qu'elle tourne, ni plus ni moins.

export const metadata: Metadata = {
  title: "Politique de confidentialité — Squash de l'Yvette",
  description:
    "Quelles données l'appli Squash de l'Yvette conserve, pourquoi, combien de temps, et comment exercer tes droits.",
};

export default function PrivacyPolicyPage() {
  return (
    <main className="legal-page">
      <Link className="legal-back" href="/">
        ← Retour à l&apos;appli
      </Link>
      <h1>Politique de confidentialité</h1>
      <p className="legal-lede">
        <strong>Squash de l&apos;Yvette</strong> (« Squash Yvette » sur Android), l&apos;appli de
        réservation des terrains de squash du Complexe de Bures. Ce texte est celui de la note
        « Confidentialité &amp; données » affichée dans l&apos;appli.
      </p>
      <div className="legal-body">
        <PrivacyContent />
      </div>
    </main>
  );
}
