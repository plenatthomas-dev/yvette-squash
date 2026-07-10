-- Délégation temporaire de droits (idée 4, cf. docs/delegation-droits.md).

-- Booking : trace qui a physiquement déclenché l'action quand ce n'est pas le
-- propriétaire de la résa (délégation). NULL = résa faite pour soi-même. Pas de FK
-- (comme PlanningSnapshot.updatedById) : simple référence informative.
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "actingUserId" TEXT;

-- CreateTable
CREATE TABLE "Delegation" (
    "id" TEXT NOT NULL,
    "delegatorId" TEXT NOT NULL,
    "delegateId" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'book_cancel',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Delegation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Delegation_delegateId_expiresAt_idx" ON "Delegation"("delegateId", "expiresAt");

-- CreateIndex
CREATE INDEX "Delegation_delegatorId_idx" ON "Delegation"("delegatorId");

-- AddForeignKey
ALTER TABLE "Delegation" ADD CONSTRAINT "Delegation_delegatorId_fkey" FOREIGN KEY ("delegatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delegation" ADD CONSTRAINT "Delegation_delegateId_fkey" FOREIGN KEY ("delegateId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
