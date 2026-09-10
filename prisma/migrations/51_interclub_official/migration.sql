-- LE RAPPORT DE VÉRIFICATION D'UNE RENCONTRE, avant que le capitaine n'aille saisir le score
-- officiel chez la fédération.
--
-- POURQUOI CETTE TABLE EXISTE
--
-- Le score officiel ne se publie pas tout seul : un capitaine le SAISIT sur squashnet, le
-- capitaine adverse le VALIDE. Les deux gestes se font des jours après la rencontre, sur un
-- formulaire qui exige les noms tels que la FÉDÉRATION les orthographie. Or l'orthographe est
-- exactement ce qui diverge d'un système à l'autre — ce dépôt porte déjà deux colonnes pour
-- réparer ça (`User.squashnetGivenName` / `squashnetFamilyName`), et un commentaire qui raconte
-- comment un rapprochement échouait « en silence, mois après mois ».
--
-- L'écran de vérification répond donc à une question précise : QUELS NOMS VONT COINCER, et on
-- veut la réponse avant d'ouvrir squashnet, pas devant un formulaire qui refuse.
--
-- POURQUOI ON LE STOCKE
--
-- Vérifier une rencontre coûte huit recherches chez la fédération (quatre simples, deux joueurs
-- chacun), espacées pour rester invisibles chez eux. Les refaire à chaque ouverture d'écran
-- ferait payer ce prix à quelqu'un qui ne fait que relire son rapport. C'est le même arbitrage
-- que `InterclubTeam.snStandingsJson` : une donnée lente, captée une fois, relue souvent.
--
-- `checkedAt` n'est pas décoratif : sans lui, « rien à signaler » et « on n'a pas encore
-- regardé » s'affichent exactement pareil, et c'est la deuxième qui coûte cher un dimanche soir.
--
-- ⚠️ AUCUNE COLONNE D'AVANCE pour la saisie ni la validation. Elles viendront avec le code qui
-- les écrit. Ce dépôt porte déjà une colonne morte (`Interclub.division`, « plus rien ne
-- l'écrit ni ne l'affiche ») et son commentaire dit ce qu'elle coûte : un champ que personne
-- n'ose supprimer parce que personne ne sait plus s'il sert.
CREATE TABLE "InterclubOfficial" (
    "id" TEXT NOT NULL,
    "interclubId" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3),
    "checkJson" TEXT,

    CONSTRAINT "InterclubOfficial_pkey" PRIMARY KEY ("id")
);

-- Une rencontre, un rapport. C'est ce qui rend la vérification REJOUABLE : relancer corrige le
-- rapport au lieu d'en empiler un second, et l'écran n'a jamais à choisir entre deux versions.
CREATE UNIQUE INDEX "InterclubOfficial_interclubId_key" ON "InterclubOfficial"("interclubId");

-- Cascade : un rapport de vérification n'a aucun sens détaché de sa rencontre. Contrairement à
-- un score, ce n'est pas un fait de jeu qu'on archive — c'est une observation sur un état qui
-- n'existe plus.
ALTER TABLE "InterclubOfficial" ADD CONSTRAINT "InterclubOfficial_interclubId_fkey"
    FOREIGN KEY ("interclubId") REFERENCES "Interclub"("id") ON DELETE CASCADE ON UPDATE CASCADE;
