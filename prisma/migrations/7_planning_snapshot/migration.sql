-- CreateTable
CREATE TABLE "PlanningSnapshot" (
    "date" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanningSnapshot_pkey" PRIMARY KEY ("date")
);
