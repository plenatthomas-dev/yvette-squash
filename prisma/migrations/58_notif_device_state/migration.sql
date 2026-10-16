-- ÉTAT DES NOTIFICATIONS, APPAREIL PAR APPAREIL.
--
-- Mesure combien de membres ne reçoivent pas les notifications, et pourquoi (refusées, jamais
-- demandées, navigateur sans support). `PushSubscription` ne voit que les appareils abonnés ;
-- les autres n'y laissaient aucune trace. Cf. le commentaire du modèle dans schema.prisma.
--
-- Rejouable : la base de recette est partagée par toutes les previews (cf. README.md).

CREATE TABLE IF NOT EXISTS "NotifDeviceState" (
    "deviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "subscribed" BOOLEAN NOT NULL,
    "platform" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotifDeviceState_pkey" PRIMARY KEY ("deviceId")
);

CREATE INDEX IF NOT EXISTS "NotifDeviceState_userId_idx" ON "NotifDeviceState"("userId");
CREATE INDEX IF NOT EXISTS "NotifDeviceState_updatedAt_idx" ON "NotifDeviceState"("updatedAt");

ALTER TABLE "NotifDeviceState" DROP CONSTRAINT IF EXISTS "NotifDeviceState_userId_fkey";
ALTER TABLE "NotifDeviceState" ADD CONSTRAINT "NotifDeviceState_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
