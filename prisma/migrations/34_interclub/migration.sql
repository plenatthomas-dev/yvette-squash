-- Interclub : les rencontres de championnat par équipes (4 simples un jeudi soir),
-- avec comptage de points en direct. Domaine entièrement nouveau — rien de tout ceci
-- n'existait en base.
--
-- Choix structurants :
--  * les modèles sont préfixés "Interclub" car "Match" est DÉJÀ pris par le module tournoi ;
--  * l'équipe est une TABLE et non une colonne figée equipe1/equipe2 : une 3e équipe un jour
--    ne coûtera qu'une ligne ;
--  * le club adverse est un TEXTE LIBRE (pas d'annuaire des clubs adverses, décision produit) ;
--  * InterclubFollow est une table d'abonnement car le chemin critique est la requête INVERSE
--    (« qui prévenir pour l'équipe 2 ? »), d'où l'index (teamId, level) ;
--  * il n'y a VOLONTAIREMENT pas de table "point" : ~200 échanges par match, soit ~800
--    écritures par soirée sur un chemin chaud que le palier gratuit ne supporte pas. Le
--    journal des points reste dans le navigateur du marqueur ; la base ne reçoit qu'un
--    instantané throttlé (InterclubMatch.liveJson) et les jeux TERMINÉS (InterclubGame).

-- CreateTable
CREATE TABLE "InterclubTeam" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InterclubTeam_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InterclubTeam_name_key" ON "InterclubTeam"("name");

-- CreateIndex
CREATE INDEX "InterclubTeam_order_idx" ON "InterclubTeam"("order");

-- CreateTable
CREATE TABLE "Interclub" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "season" TEXT,
    "division" TEXT,
    "opponent" TEXT NOT NULL,
    "home" BOOLEAN NOT NULL DEFAULT true,
    "matchCount" INTEGER NOT NULL DEFAULT 4,
    "bestOf" INTEGER NOT NULL DEFAULT 5,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Interclub_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Interclub_date_idx" ON "Interclub"("date");

-- CreateIndex
CREATE INDEX "Interclub_teamId_date_idx" ON "Interclub"("teamId", "date");

-- CreateTable
CREATE TABLE "InterclubMatch" (
    "id" TEXT NOT NULL,
    "interclubId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "homeUserId" TEXT,
    "homeDisplayName" TEXT NOT NULL,
    "awayName" TEXT NOT NULL,
    "homeColor" TEXT,
    "awayColor" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "gamesHome" INTEGER,
    "gamesAway" INTEGER,
    "scorerId" TEXT,
    "scorerClaimedAt" TIMESTAMP(3),
    "liveJson" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterclubMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InterclubMatch_interclubId_idx" ON "InterclubMatch"("interclubId");

-- CreateIndex
CREATE UNIQUE INDEX "InterclubMatch_interclubId_order_key" ON "InterclubMatch"("interclubId", "order");

-- CreateTable
CREATE TABLE "InterclubGame" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "pointsHome" INTEGER NOT NULL,
    "pointsAway" INTEGER NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "InterclubGame_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InterclubGame_matchId_number_key" ON "InterclubGame"("matchId", "number");

-- CreateTable
CREATE TABLE "InterclubFollow" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InterclubFollow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InterclubFollow_userId_teamId_key" ON "InterclubFollow"("userId", "teamId");

-- CreateIndex
CREATE INDEX "InterclubFollow_teamId_level_idx" ON "InterclubFollow"("teamId", "level");

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "teamId" TEXT;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "InterclubTeam"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interclub" ADD CONSTRAINT "Interclub_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "InterclubTeam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interclub" ADD CONSTRAINT "Interclub_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterclubMatch" ADD CONSTRAINT "InterclubMatch_interclubId_fkey" FOREIGN KEY ("interclubId") REFERENCES "Interclub"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterclubMatch" ADD CONSTRAINT "InterclubMatch_homeUserId_fkey" FOREIGN KEY ("homeUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterclubMatch" ADD CONSTRAINT "InterclubMatch_scorerId_fkey" FOREIGN KEY ("scorerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterclubGame" ADD CONSTRAINT "InterclubGame_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "InterclubMatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterclubFollow" ADD CONSTRAINT "InterclubFollow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterclubFollow" ADD CONSTRAINT "InterclubFollow_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "InterclubTeam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed des deux équipes de l'asso. Idempotent (ON CONFLICT) pour rester rejouable, et
-- pour que la recette et la prod partent du même état sans intervention manuelle.
INSERT INTO "InterclubTeam" ("id", "name", "order", "createdAt") VALUES
  ('interclub_team_1', 'Équipe 1', 1, CURRENT_TIMESTAMP),
  ('interclub_team_2', 'Équipe 2', 2, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;
