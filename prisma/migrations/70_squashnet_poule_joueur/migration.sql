-- LES RENCONTRES D'UNE POULE, ET LA FICHE D'UN JOUEUR — deux caches de pages fédérales publiques.
--
-- Le classement de poule (`ic_a=394242`) publie, sous son tableau, toutes les rencontres de la
-- poule avec le détail des simples : on les jetait. Les garder permet d'ouvrir n'importe quelle
-- équipe du classement — ses rencontres, le détail d'une soirée — sans une requête de plus.
-- La fiche d'un joueur (`ic_a=393477`) donne ses matchs de l'épreuve, toutes équipes confondues.
--
-- Deux tables neuves, sans clé étrangère : ce sont des faits publiés par la ligue, pas des
-- observations sur notre saison (même choix que `SquashnetTeamRoster`, migration 54).
-- Rejouable : la base de recette est partagée par toutes les previews (cf. README.md).

CREATE TABLE IF NOT EXISTS "SquashnetPool" (
    "snRoundId" TEXT NOT NULL,
    "snEventId" TEXT NOT NULL,
    "snDrawId" TEXT NOT NULL,
    "tiesJson" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SquashnetPool_pkey" PRIMARY KEY ("snRoundId")
);

CREATE TABLE IF NOT EXISTS "SquashnetPlayer" (
    "regiid" TEXT NOT NULL,
    "name" TEXT,
    "json" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SquashnetPlayer_pkey" PRIMARY KEY ("regiid")
);
