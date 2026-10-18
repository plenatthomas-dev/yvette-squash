-- FORFAIT ET ABANDON (audit 2026-10, point 18).
--
-- Une rencontre avec un forfait ne pouvait pas se clore : un simple ne passait « terminé »
-- qu'avec une suite de jeux complète. `outcome` dit l'issue particulière, `outcomeWinner` le
-- côté qui l'emporte.
--
-- Rejouable : la base de recette est partagée par toutes les previews (cf. README.md).

ALTER TABLE "InterclubMatch" ADD COLUMN IF NOT EXISTS "outcome" TEXT;
ALTER TABLE "InterclubMatch" ADD COLUMN IF NOT EXISTS "outcomeWinner" TEXT;

ALTER TABLE "InterclubMatch" DROP CONSTRAINT IF EXISTS "InterclubMatch_outcome_check";
ALTER TABLE "InterclubMatch" ADD CONSTRAINT "InterclubMatch_outcome_check" CHECK (
    ("outcome" IS NULL AND "outcomeWinner" IS NULL)
    OR ("outcome" IN ('forfait', 'abandon') AND "outcomeWinner" IN ('home', 'away'))
);
