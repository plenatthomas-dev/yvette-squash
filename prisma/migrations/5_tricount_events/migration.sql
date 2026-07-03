-- Tricounts par jour : les dépenses sont regroupées dans un Tricount (une date =
-- un tricount), avec validation des payeurs avant remboursements.
-- La fonctionnalité n'a jamais atteint la prod et la base dev ne contient que des
-- données de démo → on purge les dépenses existantes pour pouvoir rendre
-- Expense.tricountId obligatoire.

-- Purge (démo uniquement)
DELETE FROM "ExpenseShare";
DELETE FROM "Expense";

-- CreateTable
CREATE TABLE IF NOT EXISTS "Tricount" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tricount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "TricountApproval" (
    "id" TEXT NOT NULL,
    "tricountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TricountApproval_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TricountApproval_tricountId_fkey" FOREIGN KEY ("tricountId") REFERENCES "Tricount"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TricountApproval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- AlterTable (table vide après la purge : NOT NULL sans défaut passe)
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "tricountId" TEXT NOT NULL;
ALTER TABLE "Expense" DROP CONSTRAINT IF EXISTS "Expense_tricountId_fkey";
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_tricountId_fkey" FOREIGN KEY ("tricountId") REFERENCES "Tricount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Tricount_date_key" ON "Tricount"("date");
CREATE UNIQUE INDEX IF NOT EXISTS "TricountApproval_tricountId_userId_key" ON "TricountApproval"("tricountId", "userId");
CREATE INDEX IF NOT EXISTS "Expense_tricountId_idx" ON "Expense"("tricountId");
