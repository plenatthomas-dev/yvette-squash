-- Format « poules + tableau final » (pools_bracket) : chaque match de phase finale
-- appartient à un TABLEAU par rang de poule (1 = 1ers de chaque poule, 2 = 2es…).
-- NULL pour les matchs de poule et les tableaux autonomes (repêchage intégral).
ALTER TABLE "Match" ADD COLUMN "tier" INTEGER;
