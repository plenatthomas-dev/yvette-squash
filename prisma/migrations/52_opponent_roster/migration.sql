-- LE ROSTER DE L'ÉQUIPE ADVERSE, LU CHEZ LA FÉDÉRATION.
--
-- POURQUOI CES DEUX CHANGEMENTS
--
-- Jusqu'ici, tout ce qu'on savait des joueurs d'en face venait de NOS PROPRES rencontres : le
-- nom saisi sur une feuille de match, et — quand un capitaine avait vérifié — l'identité
-- fédérale que son rapport avait pu RAPPROCHER. Ce rapprochement coûte une recherche par
-- joueur, échoue sur un accent, et rend un « introuvable » qu'on ne peut pas distinguer d'un
-- silence du site. Surtout, il ne peut rien dire d'un club jamais croisé : le menu des joueurs
-- adverses restait vide, et l'ordre des simples d'en face invérifiable, exactement au moment
-- où on en a besoin — la première rencontre de la saison.
--
-- Or la fédération publie ces joueurs elle-même, avec leur licence, leur classement et leur
-- rang mixte, sur la fiche de chaque équipe (`ic_a=393480`, un seul paramètre : `teamid`).
-- Une requête par équipe remplace huit recherches, et il n'y a plus rien à deviner.
--
-- 1. `Interclub.snOpponentTeamId` — LA CLÉ QU'ON JETAIT
--
-- Le calendrier fédéral publie le `teamid` des DEUX équipes de chaque rencontre, et le parsing
-- le lisait déjà. C'est `ownFixtures` qui ne gardait que le nom. On cherchait donc les joueurs
-- d'en face par leur orthographe alors que la ligue nous avait donné leur identifiant.
--
-- NULLABLE, et sans remplissage rétroactif possible ici : les rencontres déjà en base ne le
-- portent pas, et seul un ré-import du calendrier peut le poser (il est dans le HTML, pas dans
-- nos données). Une rencontre sans cet identifiant n'a simplement pas de roster — jamais un
-- roster faux, ce que la garde de parsing (`RosterUnreadableError`) tient de son côté.
ALTER TABLE "Interclub" ADD COLUMN "snOpponentTeamId" TEXT;

-- 2. `SquashnetTeamRoster` — LE CACHE
--
-- UNE LIGNE PAR ÉQUIPE, patron d'`InterclubOfficial` et de `InterclubTeam.snStandingsJson` :
-- une donnée lente, captée une fois, relue souvent. Un effectif ne bouge que quand un club
-- inscrit un joueur ; le relire à chaque ouverture d'un menu ferait payer à squashnet le
-- simple fait de composer une rencontre.
--
-- LA CLÉ EST LE `teamid`, PAS LE NOM. Le nom porte le numéro d'équipe (« Verrieres 2 »), change
-- de casse d'une saison à l'autre, et deux clubs d'un même réseau ne diffèrent que par un
-- chiffre. C'est la leçon de `StandingRow.snTeamId`, où le même choix est déjà fait et
-- commenté.
--
-- PAS DE CLÉ ÉTRANGÈRE VERS `Interclub`. Un roster appartient à une ÉQUIPE, pas à une
-- rencontre : cinq rencontres contre le même club partagent une seule ligne, et le roster
-- survit à la suppression d'une rencontre — c'est un fait publié par la ligue, pas une
-- observation sur notre saison.
CREATE TABLE "SquashnetTeamRoster" (
    "snTeamId" TEXT NOT NULL,
    "name" TEXT,
    "club" TEXT,
    "code" TEXT,
    "rosterJson" TEXT,
    -- Quand on a regardé. Ce qui distingue « cette équipe n'a inscrit personne » de « on n'a
    -- pas encore demandé » — sans lui, les deux s'affichent pareil, et c'est le second qui
    -- envoie chercher une explication qui n'existe pas. Même rôle que `checkedAt`.
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SquashnetTeamRoster_pkey" PRIMARY KEY ("snTeamId")
);
