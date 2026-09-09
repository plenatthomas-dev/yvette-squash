-- L'HISTORIQUE DU CLASSEMENT FÉDÉRAL — un point par joueur et par mois.
--
-- Ce que ça débloque : la COURBE. Jusqu'ici, chaque passe mensuelle écrasait le classement de
-- la veille dans `SquashnetRanking` ; on savait où en était un joueur, jamais d'où il venait.
-- La question que le club se pose devant l'annuaire — « est-ce qu'il progresse ? » — n'avait
-- aucune donnée pour y répondre, et n'en aurait eu qu'après des mois d'attente.
--
-- Elle est répondable TOUT DE SUITE, et c'est la découverte qui justifie cette table : le
-- sélecteur de période de squashnet (`<select id="month">`) expose les publications PASSÉES,
-- et l'endpoint de recherche accepte n'importe laquelle d'entre elles. L'historique se
-- REMPLIT DONC EN ARRIÈRE (cf. `scripts/backfill-rankings.ts`) au lieu de s'accumuler.
--
-- Pourquoi une table et non trois colonnes de plus sur `SquashnetRanking` :
--   * `SquashnetRanking` est sur un chemin CHAUD (annuaire, ordre des simples interclub), lue
--     à chaque affichage et jointe partout. Elle doit rester une ligne par joueur ;
--   * l'historique est FROID : on l'ouvre pour regarder une courbe, quelques fois par mois.
--
-- Pourquoi `mean` (la moyenne de points) alors que l'annuaire ne l'affiche pas : c'est la
-- SEULE des quatre valeurs qui bouge tous les mois. Le classement (« 5A ») change deux ou
-- trois fois dans une vie de joueur, le rang dépend autant des autres que de soi. Une courbe
-- de classement serait une ligne plate.
--
-- `userId` / `guestId` : les deux populations du module (un membre, ou un joueur d'équipe sans
-- compte), exclusives et jamais nulles ensemble — Prisma ne sait pas exprimer ce XOR, la
-- contrainte ci-dessous si.
CREATE TABLE "SquashnetRankingPoint" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "guestId" TEXT,
    "month" TEXT NOT NULL,
    "clt" TEXT NOT NULL,
    "rang" INTEGER,
    "rangM" INTEGER,
    "mean" DOUBLE PRECISION,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SquashnetRankingPoint_pkey" PRIMARY KEY ("id")
);

-- Le XOR, tenu par la base et pas seulement par le code : une ligne sans sujet serait invisible
-- de tous les écrans et impossible à rattacher après coup, une ligne à deux sujets s'afficherait
-- deux fois sous deux noms.
ALTER TABLE "SquashnetRankingPoint"
    ADD CONSTRAINT "sn_point_un_seul_sujet"
    CHECK (("userId" IS NULL) <> ("guestId" IS NULL));

-- Un joueur, un mois, un point : c'est ce qui rend le backfill et le cron mensuel REJOUABLES.
-- Un run qui repasse sur un mois déjà capté corrige la ligne au lieu d'en empiler une seconde.
-- NULL étant distinct de NULL en Postgres, l'index « membre » laisse passer tous les invités
-- (dont `userId` est NULL) et réciproquement : les deux contraintes coexistent sans se gêner.
CREATE UNIQUE INDEX "SquashnetRankingPoint_userId_month_key" ON "SquashnetRankingPoint"("userId", "month");
CREATE UNIQUE INDEX "SquashnetRankingPoint_guestId_month_key" ON "SquashnetRankingPoint"("guestId", "month");

-- La courbe se lit par MOIS (« tous les joueurs entre janvier et juin »), jamais joueur par
-- joueur : c'est la plage de mois qui filtre, et les deux index uniques ci-dessus ne servent
-- pas cette requête-là (leur colonne de tête est le sujet).
CREATE INDEX "SquashnetRankingPoint_month_idx" ON "SquashnetRankingPoint"("month");

-- Cascade des deux côtés : un compte supprimé ou un joueur retiré du roster emporte ses
-- mesures. Contrairement à un score de rencontre, un point de classement n'a aucune valeur
-- d'archive une fois détaché de son joueur — c'est une mesure, pas un fait de jeu.
ALTER TABLE "SquashnetRankingPoint" ADD CONSTRAINT "SquashnetRankingPoint_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SquashnetRankingPoint" ADD CONSTRAINT "SquashnetRankingPoint_guestId_fkey"
    FOREIGN KEY ("guestId") REFERENCES "InterclubGuest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
