-- Rang national MIXTE lu sur squashnet (colonne « rangM » de la fiche, « M » pour mixte et non
-- masculin). C'est le nombre que le joueur voit sur sa propre fiche — donc celui qu'affiche
-- l'annuaire — et le seul comparable entre tous les membres, alors que « rang » (déjà stocké)
-- situe le joueur DANS SON GENRE et sert au tri des têtes de série.
-- Nullable : une ligne existante reste valable et se remplira au prochain rafraîchissement
-- des classements (cron warm-rankings / bouton admin) — il n'y a rien à recalculer localement,
-- la valeur ne vient que de squashnet.
-- Écrit en « IF NOT EXISTS » pour rester idempotent (cohérent avec les migrations précédentes).

-- AlterTable
ALTER TABLE "SquashnetRanking" ADD COLUMN IF NOT EXISTS "rangM" INTEGER;
