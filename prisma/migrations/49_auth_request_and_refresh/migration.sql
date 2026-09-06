ALTER TABLE "Session" ADD COLUMN "refreshClaimedAt" TIMESTAMP(3);

CREATE TABLE "EmailRequestAttempt" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailRequestAttempt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EmailRequestAttempt_email_createdAt_idx" ON "EmailRequestAttempt"("email", "createdAt");
CREATE INDEX "EmailRequestAttempt_ip_createdAt_idx" ON "EmailRequestAttempt"("ip", "createdAt");
