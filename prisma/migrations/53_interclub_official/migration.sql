-- ⚠️ MIGRATION RENUMÉROTÉE, ET REJOUABLE POUR CETTE RAISON.
--
-- Elle s'appelait `51_interclub_official`. La branche avait été créée avant que `main` ne pose sa propre
-- migration `51_squashnet_ranking_probe`, et les deux ont pris le même numéro. Git n'y voit rien — ce sont
-- deux dossiers différents — mais le préfixe EST le contrat d'ordre de ce dépôt, et
-- `prisma/migrations/README.md` raconte deux incidents de production nés de cette ambiguïté.
--
-- La production n'a jamais vu cette migration : la renuméroter ne lui coûte rien. La base
-- `dev`, partagée par toutes les previews, l'a en revanche déjà appliquée sous son ANCIEN
-- nom. Pour Prisma, le nouveau nom est une migration pendante : il va la rejouer sur une base
-- qui porte déjà ses objets. D'où les `IF NOT EXISTS` ci-dessous — ils ne sont pas de la
-- prudence décorative, ils sont ce qui évite un `already exists` (P3018) et un déploiement
-- de preview bloqué jusqu'à un `migrate resolve` à la main. Sur une base vierge, ils ne
-- changent rien.
--
-- La ligne de l'ancien nom reste dans `_prisma_migrations` de `dev`, inoffensive — comme la
-- ligne `10_passkey_backup` que la production garde depuis 2026 (cf. le README des migrations).

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
CREATE TABLE IF NOT EXISTS "InterclubOfficial" (
    "id" TEXT NOT NULL,
    "interclubId" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3),
    "checkJson" TEXT,

    CONSTRAINT "InterclubOfficial_pkey" PRIMARY KEY ("id")
);

-- Une rencontre, un rapport. C'est ce qui rend la vérification REJOUABLE : relancer corrige le
-- rapport au lieu d'en empiler un second, et l'écran n'a jamais à choisir entre deux versions.
CREATE UNIQUE INDEX IF NOT EXISTS "InterclubOfficial_interclubId_key" ON "InterclubOfficial"("interclubId");

-- Cascade : un rapport de vérification n'a aucun sens détaché de sa rencontre. Contrairement à
-- un score, ce n'est pas un fait de jeu qu'on archive — c'est une observation sur un état qui
-- n'existe plus.
-- Une contrainte ne connaît pas `IF NOT EXISTS` : on la retire d'abord si elle est là.
ALTER TABLE "InterclubOfficial" DROP CONSTRAINT IF EXISTS "InterclubOfficial_interclubId_fkey";
ALTER TABLE "InterclubOfficial" ADD CONSTRAINT "InterclubOfficial_interclubId_fkey"
    FOREIGN KEY ("interclubId") REFERENCES "Interclub"("id") ON DELETE CASCADE ON UPDATE CASCADE;
