-- Invité hors asso sur un Tricount (idée : "JohnDoe (ext)") : nom libre, aucun
-- compte, aucune connexion. Peut porter une part (ExpenseShare.guestId) et être
-- le "payeur" d'un remboursement qu'il a fait en main propre à son créancier
-- (Expense.payerGuestId) — jamais le payeur d'une vraie dépense (enforcé côté
-- appli, pas en base). payerId/userId deviennent nullable ; un CHECK garantit
-- qu'exactement un des deux (membre OU invité) est renseigné.

-- CreateTable
CREATE TABLE "TricountGuest" (
    "id" TEXT NOT NULL,
    "tricountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TricountGuest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TricountGuest_tricountId_idx" ON "TricountGuest"("tricountId");

-- CreateIndex
CREATE UNIQUE INDEX "TricountGuest_tricountId_name_key" ON "TricountGuest"("tricountId", "name");

-- AddForeignKey
ALTER TABLE "TricountGuest" ADD CONSTRAINT "TricountGuest_tricountId_fkey" FOREIGN KEY ("tricountId") REFERENCES "Tricount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Expense" ALTER COLUMN "payerId" DROP NOT NULL;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "payerGuestId" TEXT;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_payerGuestId_fkey" FOREIGN KEY ("payerGuestId") REFERENCES "TricountGuest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddCheckConstraint (pas de représentation native côté schema.prisma)
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_payer_xor_guest" CHECK (("payerId" IS NOT NULL) <> ("payerGuestId" IS NOT NULL));

-- AlterTable
ALTER TABLE "ExpenseShare" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "ExpenseShare" ADD COLUMN IF NOT EXISTS "guestId" TEXT;

-- CreateIndex
CREATE INDEX "ExpenseShare_guestId_idx" ON "ExpenseShare"("guestId");

-- Index partiel : @@unique([expenseId, userId]) existant ne protège pas les
-- lignes invité (Postgres traite NULL comme distinct) — un même invité pourrait
-- sinon apparaître deux fois sur la même dépense.
CREATE UNIQUE INDEX "ExpenseShare_expenseId_guestId_key" ON "ExpenseShare"("expenseId", "guestId") WHERE "guestId" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "ExpenseShare" ADD CONSTRAINT "ExpenseShare_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "TricountGuest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddCheckConstraint (pas de représentation native côté schema.prisma)
ALTER TABLE "ExpenseShare" ADD CONSTRAINT "ExpenseShare_user_xor_guest" CHECK (("userId" IS NOT NULL) <> ("guestId" IS NOT NULL));
