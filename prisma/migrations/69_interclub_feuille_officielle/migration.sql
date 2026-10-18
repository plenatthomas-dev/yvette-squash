-- LA FEUILLE DE MATCH OFFICIELLE, GARDÉE SUR LA RENCONTRE.
--
-- Le palmarès des joueurs se calculait sur nos seuls relevés : une soirée non marquée dans
-- l'appli n'existait pas, et les pourcentages de tout le monde en étaient faussés. Il se calcule
-- désormais sur la feuille que la ligue publie (cf. src/lib/interclub-sheets.ts).
--
-- Trois colonnes nullables, sans valeur par défaut : rien à réécrire sur les lignes existantes.
-- Rejouable : la base de recette est partagée par toutes les previews (cf. README.md).

ALTER TABLE "Interclub" ADD COLUMN IF NOT EXISTS "snSheetJson" TEXT;
ALTER TABLE "Interclub" ADD COLUMN IF NOT EXISTS "snSheetSide" TEXT;
ALTER TABLE "Interclub" ADD COLUMN IF NOT EXISTS "snSheetAt" TIMESTAMP(3);
