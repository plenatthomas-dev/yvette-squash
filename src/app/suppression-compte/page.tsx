import type { Metadata } from "next";
import Link from "next/link";
import { AccountDeletion } from "@/components/AccountDeletion";

// Page PUBLIQUE de suppression de compte : /suppression-compte.
//
// Google Play exige, pour toute appli où l'on crée un compte, une page web où DEMANDER la
// suppression du compte et des données, sans devoir réinstaller l'appli, qui nomme l'appli ou
// son éditeur tels qu'ils figurent sur la fiche du Store, et qui dit ce qui est supprimé, ce
// qui est conservé et combien de temps (cf. docs/etude-app-android.md §8). Les Paramètres de
// l'appli y renvoient : c'est aussi le chemin « dans l'appli » qu'exige la même règle.

export const metadata: Metadata = {
  title: "Supprimer ton compte — Squash de l'Yvette",
  description:
    "Demander la suppression de ton compte Squash de l'Yvette : comment faire, ce qui est supprimé et ce qui est conservé.",
};

export default function AccountDeletionPage() {
  return (
    <main className="legal-page">
      <Link className="legal-back" href="/">
        ← Retour à l&apos;appli
      </Link>
      <AccountDeletion />
    </main>
  );
}
