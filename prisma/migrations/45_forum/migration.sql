-- LE FIL DE DISCUSSION DU CLUB.
--
-- Un seul fil pour toute l'association (pas de salons). L'historique fait foi ici : le
-- courtier temps réel ne transporte que des copies, et « qui est en ligne » / « X écrit… »
-- restent éphémères, hors base, à dessein.
--
-- `ON DELETE CASCADE` sur l'auteur : la note de confidentialité promet que les données du
-- membre partent avec son compte. Le fil garde donc des trous, et c'est voulu.
--
-- Conservation 12 mois, appliquée par une purge opportuniste à l'écriture (le plan Vercel
-- plafonne les crons) : d'où l'index sur `createdAt` seul, qui sert à la fois la lecture du
-- fil (du plus récent au plus ancien) et le balayage de la purge.

-- CreateTable
CREATE TABLE "ForumMessage" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForumMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ForumMessage_createdAt_idx" ON "ForumMessage"("createdAt");

-- CreateIndex
CREATE INDEX "ForumMessage_authorId_createdAt_idx" ON "ForumMessage"("authorId", "createdAt");

-- AddForeignKey
ALTER TABLE "ForumMessage" ADD CONSTRAINT "ForumMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable : état du fil rattaché au COMPTE et non au navigateur (téléphone partagé).
-- `forumMuted` est un OPT-OUT : par défaut on reçoit, sinon le fil ne vit pas.
ALTER TABLE "User" ADD COLUMN     "forumReadAt" TIMESTAMP(3),
ADD COLUMN     "forumMuted" BOOLEAN NOT NULL DEFAULT false;
