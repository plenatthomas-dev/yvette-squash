-- Journal des notifications, affiché sous la cloche.
--
-- Le push est fragile par nature : permission refusée, notifications coupées au niveau du
-- système, iPhone hors écran d'accueil, appareil éteint. Une notification perdue l'était
-- définitivement, sans que le membre puisse même savoir qu'elle avait existé. Cette table est
-- le repli : elle s'affiche dans l'appli, que le push ait fonctionné ou non.
--
-- Table nommée "AppNotification" et non "Notification" : ce dernier est le type DOM des
-- navigateurs, et la confusion serait un piège pour le code client.

-- CreateTable
CREATE TABLE "AppNotification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "url" TEXT,
    "tag" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "AppNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AppNotification_userId_createdAt_idx" ON "AppNotification"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "AppNotification" ADD CONSTRAINT "AppNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
