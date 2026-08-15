-- CreateTable
CREATE TABLE "TricountComment" (
    "id" TEXT NOT NULL,
    "tricountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TricountComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TricountComment_tricountId_createdAt_idx" ON "TricountComment"("tricountId", "createdAt");

-- AddForeignKey
ALTER TABLE "TricountComment" ADD CONSTRAINT "TricountComment_tricountId_fkey" FOREIGN KEY ("tricountId") REFERENCES "Tricount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TricountComment" ADD CONSTRAINT "TricountComment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
