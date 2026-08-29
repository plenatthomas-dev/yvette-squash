// Amorçage des tests de composants (projet « dom » de vitest.config.ts).
//
// Deux nettoyages, et le second n'est pas cosmétique : `InterclubScorer` garde le journal des
// points dans `localStorage`, sous une clé dérivée de l'identifiant du match. Un document jsdom
// est partagé par tous les tests d'un même fichier — sans purge, un test hériterait du journal
// du précédent et le marqueur repartirait d'un score qu'aucun test n'a écrit.
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  try {
    localStorage.clear();
  } catch {
    /* stockage refusé : rien à purger */
  }
});
