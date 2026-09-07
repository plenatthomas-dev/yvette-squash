import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { recordCronRun } from "@/lib/cron-run";
import { getFeatures } from "@/lib/features-server";
import { backfillHistory, MOIS_PAR_DEFAUT } from "@/lib/squashnet/backfill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/admin/backfill-rankings
//
// COMPLÈTE L'HISTORIQUE DU CLASSEMENT (la courbe de progression), à la demande d'un admin.
//
// ⚠️ ELLE NE FAIT QU'UNE TRANCHE, ET C'EST LE POINT DE CONCEPTION. Un chargement complet —
// quarante joueurs sur vingt-quatre mois — représente un quart d'heure de requêtes espacées,
// quand une fonction Vercel est tuée à soixante secondes. La route s'arrête donc d'elle-même
// avant le couperet (`BUDGET_MS`) et rend un compte-rendu HONNÊTE : ce qu'elle a fait, et
// combien il reste. L'admin reclique jusqu'à ce que « reste » tombe à zéro.
//
// Ce découpage n'est sûr que parce que le remplissage est REPRENABLE : les couples
// (joueur, mois) déjà en base sont sautés sans un seul appel réseau (cf. `knownPoints`). Deux
// clics de suite ne repayent jamais le même travail — et sur un historique à jour, le second
// clic ne fait AUCUNE requête.
//
// Pour un premier chargement, `npm run rankings:backfill` reste la bonne porte : il n'a pas de
// couperet, donc pas de tranches.
//
// Accès réservé aux admins (allowlist ADMIN_EMAILS) + flag `ranking`.

/**
 * Le budget de travail, tenu SOUS `maxDuration` avec de la marge.
 *
 * Quinze secondes de réserve, et elles ne sont pas décoratives : la dernière requête engagée
 * peut prendre les dix secondes du délai de garde de `postAjax`, et il faut encore écrire le
 * point puis sérialiser la réponse. Sans cette marge, le run le plus utile — celui qui va au
 * bout du budget — serait précisément celui que Vercel tuerait, sans compte-rendu.
 */
const BUDGET_MS = 45_000;

/**
 * Délai entre deux appels, plus court que celui du script (1,1 s).
 *
 * Le script tourne un quart d'heure sans surveillance : il s'aligne sur le rythme d'un humain
 * qui pagine. Ici on tient moins d'une minute, et l'admin attend devant son écran — 600 ms
 * reste une cadence qu'un site associatif ne remarque pas, et double ce qu'une tranche rapporte.
 */
const DELAI_INTERACTIF_MS = 600;

export async function POST(req: NextRequest) {
  if (!(await requireAdmin(req))) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }
  if (!(await getFeatures()).ranking) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }

  const res = await backfillHistory({
    months: MOIS_PAR_DEFAUT,
    delayMs: DELAI_INTERACTIF_MS,
    budgetMs: BUDGET_MS,
  });

  if (res.months.length === 0) {
    return NextResponse.json(
      { error: "Aucune période de classement publiée (squashnet indisponible ?)." },
      { status: 502 },
    );
  }

  // Le run est un ÉCHEC si la base a refusé des écritures, ou si squashnet n'a rien conclu de
  // tout ce qu'on lui a demandé (site muet) — un run qui n'a rien eu à faire, lui, va bien.
  const tente = res.written + res.unresolved + res.failed;
  const ok = res.failed === 0 && (tente === 0 || res.written > 0 || res.requests === 0);

  // Heartbeat sous une clé À LUI : compléter l'historique n'est pas rafraîchir les classements,
  // et faire passer au vert la ligne d'un autre travail masquerait sa panne.
  await recordCronRun(
    "rankings-historique-manuel",
    ok,
    `${res.written} écrit(s), ${res.already} déjà connu(s), ${res.unresolved} sans réponse, ` +
      `${res.failed} échec(s) base, ${res.remaining} restant(s)`,
  );

  const { months, subjects, requests, written, already, unresolved, failed, remaining, stopped } =
    res;
  return NextResponse.json({
    ok,
    months: months.length,
    subjects,
    requests,
    written,
    already,
    unresolved,
    failed,
    remaining,
    stopped,
  });
}
