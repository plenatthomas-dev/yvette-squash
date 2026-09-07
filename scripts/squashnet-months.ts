/**
 * DIAGNOSTIC : jusqu'où remonte l'historique DISPONIBLE chez la fédération ?
 *
 * À lancer quand la courbe « Progression » s'arrête à une date qu'on n'explique pas. Il répond à
 * la seule question qui départage les causes possibles : squashnet publie-t-il seulement N mois,
 * ou est-ce nous qui n'avons pas fini d'aller les chercher ?
 *
 * UNE SEULE REQUÊTE, aucune écriture, aucune base : il lit le sélecteur de période du classement
 * (`<select id="month">`) et l'imprime tel quel.
 *
 * Usage :
 *   node --import tsx scripts/squashnet-months.ts
 *
 * Lecture du résultat :
 *   • la liste s'arrête à janvier 2026  → la fédération ne publie pas plus loin, il n'y a RIEN à
 *     récupérer au-delà. `MOIS_PAR_DEFAUT` (24) est alors une profondeur que la source ne peut
 *     pas tenir, et ce n'est pas un défaut de l'appli ;
 *   • la liste remonte plus loin que la courbe → le remplissage n'a pas fini son travail :
 *     relancer « Compléter l'historique » (ou `npm run rankings:backfill`) jusqu'à ce que le
 *     compte-rendu annonce zéro restant.
 */
import { getMonths } from "../src/lib/squashnet/client";

async function main() {
  const mois = await getMonths();
  if (mois.length === 0) {
    console.error(
      "Aucune période lue. Soit squashnet est injoignable, soit le rendu du sélecteur a changé " +
        "(cf. parseMonths, et recapturer une fixture).",
    );
    process.exitCode = 1;
    return;
  }
  console.log(`${mois.length} période(s) publiée(s) par squashnet, la plus récente en tête :\n`);
  for (const m of mois) console.log(`  ${m}`);
  console.log(`\nLa plus ancienne récupérable est donc : ${mois[mois.length - 1]}`);
  console.log(
    "Si la courbe s'arrête APRÈS cette date, c'est le remplissage qui n'a pas fini — reclique\n" +
      "« Compléter l'historique » dans /admin jusqu'à « historique complet ».",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
