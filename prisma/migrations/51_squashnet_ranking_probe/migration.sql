-- LA MÉMOIRE DES TROUS — ce qu'on a déjà demandé à la fédération sans rien obtenir.
--
-- `SquashnetRankingPoint` (migration 50) dit ce qu'on SAIT. Cette table-ci dit ce qu'on a
-- CHERCHÉ EN VAIN, et c'est ce qui manquait pour que le remplissage rétroactif se termine.
--
-- Le défaut qu'elle ferme : le bouton « Compléter l'historique » travaille par tranches de 45 s
-- (une fonction Vercel est tuée à 60) et invite l'admin à recliquer « jusqu'à ce que reste
-- tombe à zéro ». Seuls les couples ÉCRITS étaient sautés au passage suivant. Or les couples
-- non concluants sont pour l'essentiel DÉFINITIVEMENT non concluants — un membre entré au club
-- l'an dernier n'a pas de classement sur les mois d'avant, et n'en aura jamais. Chaque clic
-- repartait donc du mois le plus récent en repayant ces recherches-là, s'épuisait au même
-- endroit, et le compteur ne descendait plus : à quarante joueurs sur vingt-quatre périodes,
-- des centaines de requêtes par clic envoyées à un site associatif pour un résultat connu
-- d'avance, et un « reste » qui ne tombait jamais à zéro.
--
-- ⚠️ ON NE MARQUE QUE CE QUE SQUASHNET A RÉPONDU. Une requête en échec (réseau, 5xx, timeout)
-- ne laisse AUCUNE ligne ici : c'est un incident, pas un verdict, et le passage suivant doit la
-- reprendre. Seule une réponse REÇUE où le joueur n'apparaît pas est consignée — un classement
-- publié ne change plus, donc l'absence est définitive.
--
-- `verdict` garde la nuance de `classifyRanking` pour l'audit : « moved » (nom retrouvé hors du
-- club ce mois-là) ou « unknown » (introuvable, ou homonymes indépartageables). Le second peut
-- se dénouer si un admin corrige le nom de recherche : d'où la reprise forcée du script, qui
-- ignore ces marques.
CREATE TABLE "SquashnetRankingProbe" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "guestId" TEXT,
    "month" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "probedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SquashnetRankingProbe_pkey" PRIMARY KEY ("id")
);

-- Le XOR, tenu par la base comme sur `SquashnetRankingPoint` : une ligne sans sujet serait
-- impossible à rattacher, une ligne à deux sujets masquerait deux joueurs d'un coup.
ALTER TABLE "SquashnetRankingProbe"
    ADD CONSTRAINT "sn_probe_un_seul_sujet"
    CHECK (("userId" IS NULL) <> ("guestId" IS NULL));

-- Un joueur, un mois, un état : repasser corrige la ligne au lieu d'en empiler une seconde.
-- NULL étant distinct de NULL en Postgres, les deux index coexistent (cf. migration 50).
CREATE UNIQUE INDEX "SquashnetRankingProbe_userId_month_key" ON "SquashnetRankingProbe"("userId", "month");
CREATE UNIQUE INDEX "SquashnetRankingProbe_guestId_month_key" ON "SquashnetRankingProbe"("guestId", "month");

-- La lecture est « toutes les marques de ces mois-là », d'un coup, avant de commencer.
CREATE INDEX "SquashnetRankingProbe_month_idx" ON "SquashnetRankingProbe"("month");

-- Cascade des deux côtés, comme les points : une marque détachée de son joueur ne veut plus
-- rien dire, et la garder empêcherait de rechercher un homonyme réinscrit plus tard.
ALTER TABLE "SquashnetRankingProbe" ADD CONSTRAINT "SquashnetRankingProbe_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SquashnetRankingProbe" ADD CONSTRAINT "SquashnetRankingProbe_guestId_fkey"
    FOREIGN KEY ("guestId") REFERENCES "InterclubGuest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
