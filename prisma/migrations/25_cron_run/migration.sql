-- Heartbeat des crons (mini-tableau de bord admin, étape 4). Une ligne par cron, écrasée à
-- chaque passage.
-- CreateTable
CREATE TABLE "CronRun" (
    "name" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3) NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "info" TEXT,

    CONSTRAINT "CronRun_pkey" PRIMARY KEY ("name")
);
