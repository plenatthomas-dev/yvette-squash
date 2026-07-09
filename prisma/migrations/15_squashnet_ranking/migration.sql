-- Classement fédéral (FFSquash) rapproché depuis squashnet.fr (source publique),
-- rafraîchi mensuellement par cron. Un enregistrement par membre (userId unique).

-- CreateTable
CREATE TABLE "SquashnetRanking" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clt" TEXT NOT NULL,
    "rang" INTEGER,
    "licence" TEXT,
    "cat" TEXT,
    "club" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SquashnetRanking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SquashnetRanking_userId_key" ON "SquashnetRanking"("userId");

-- AddForeignKey
ALTER TABLE "SquashnetRanking" ADD CONSTRAINT "SquashnetRanking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
