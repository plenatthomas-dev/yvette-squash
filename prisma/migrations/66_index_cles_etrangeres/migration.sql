-- INDEX DES CLÉS ÉTRANGÈRES, ET MEMBRE XOR INVITÉ SUR LES DISPONIBILITÉS (audit 2026-10, point 20).
--
-- Postgres n'indexe pas une clé étrangère de lui-même. Sans index, chaque suppression d'un
-- membre (ou d'un invité, d'une équipe…) balaie la table entière pour appliquer son ON DELETE,
-- et les lectures « les dépenses payées par X » font de même. Liste établie en interrogeant
-- `pg_constraint` : chaque clé étrangère à une colonne sans index qui la commence.
--
-- Rejouable : la base de recette est partagée par toutes les previews (cf. README.md).

CREATE INDEX IF NOT EXISTS "User_teamId_idx" ON "User"("teamId");
CREATE INDEX IF NOT EXISTS "Expense_creatorId_idx" ON "Expense"("creatorId");
CREATE INDEX IF NOT EXISTS "Expense_payerGuestId_idx" ON "Expense"("payerGuestId");
CREATE INDEX IF NOT EXISTS "Expense_payerId_idx" ON "Expense"("payerId");
CREATE INDEX IF NOT EXISTS "TricountApproval_userId_idx" ON "TricountApproval"("userId");
CREATE INDEX IF NOT EXISTS "TricountComment_userId_idx" ON "TricountComment"("userId");
CREATE INDEX IF NOT EXISTS "Tournament_createdById_idx" ON "Tournament"("createdById");
CREATE INDEX IF NOT EXISTS "TournamentPlayer_groupId_idx" ON "TournamentPlayer"("groupId");
CREATE INDEX IF NOT EXISTS "Interclub_createdById_idx" ON "Interclub"("createdById");
CREATE INDEX IF NOT EXISTS "InterclubMatch_homeGuestId_idx" ON "InterclubMatch"("homeGuestId");
CREATE INDEX IF NOT EXISTS "InterclubMatch_homeUserId_idx" ON "InterclubMatch"("homeUserId");
CREATE INDEX IF NOT EXISTS "InterclubMatch_scorerId_idx" ON "InterclubMatch"("scorerId");
CREATE INDEX IF NOT EXISTS "InterclubAvailability_guestId_idx" ON "InterclubAvailability"("guestId");
CREATE INDEX IF NOT EXISTS "InterclubAvailability_setById_idx" ON "InterclubAvailability"("setById");
CREATE INDEX IF NOT EXISTS "InterclubAvailability_userId_idx" ON "InterclubAvailability"("userId");

-- Une disponibilité porte UN membre OU UN invité, jamais les deux ni aucun — comme
-- `ExpenseShare` et `SquashnetRankingPoint`. NOT VALID : la règle vaut pour toute écriture à
-- venir sans faire échouer le déploiement si une ancienne ligne y dérogeait ; un
-- `VALIDATE CONSTRAINT` pourra la durcir une fois la base vérifiée.
ALTER TABLE "InterclubAvailability" DROP CONSTRAINT IF EXISTS "InterclubAvailability_user_xor_guest";
ALTER TABLE "InterclubAvailability" ADD CONSTRAINT "InterclubAvailability_user_xor_guest"
    CHECK (("userId" IS NULL) <> ("guestId" IS NULL)) NOT VALID;
