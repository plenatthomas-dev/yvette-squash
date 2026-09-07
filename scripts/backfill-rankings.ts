/**
 * REMPLISSAGE RÉTROACTIF DE L'HISTORIQUE DU CLASSEMENT FÉDÉRAL.
 *
 * À lancer UNE FOIS, à la main, pour donner à la courbe de progression les deux ans qu'elle
 * n'aurait sinon qu'après deux ans d'attente. Ensuite, la passe mensuelle (`warm-rankings`)
 * entretient l'historique toute seule : elle écrit son point à chaque rapprochement réussi.
 *
 * Usage :
 *   node --env-file=.env --import tsx scripts/backfill-rankings.ts [--mois=24] [--delai=1100]
 *
 * ⚠️ IL VISE LA BASE DE `DATABASE_URL` — donc la PRODUCTION si c'est elle que le `.env` désigne.
 * C'est l'usage prévu (l'historique n'a d'intérêt que là où vivent les joueurs), mais ça se
 * vérifie avant de lancer : le script annonce l'hôte de la base et attend cinq secondes.
 *
 * ⚠️ IL PREND DU TEMPS, ET C'EST VOULU. Quarante joueurs sur vingt-quatre mois, à un appel par
 * seconde, font environ un quart d'heure — squashnet est un site associatif qui ne nous doit
 * rien, et le seul moyen de rester invisible chez eux est de ne pas se presser. Interrompre le
 * script (Ctrl-C) ne perd rien : les points déjà écrits sont sautés au run suivant.
 */
import { backfillHistory, DELAI_MS, MOIS_PAR_DEFAUT } from "../src/lib/squashnet/backfill";

/** `--mois=24` → 24. Rend le défaut si l'argument est absent ou illisible. */
function entierArg(nom: string, defaut: number): number {
  const brut = process.argv.find((a) => a.startsWith(`--${nom}=`))?.split("=")[1];
  const n = Number.parseInt(brut ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : defaut;
}

/** L'hôte de la base, sans les identifiants — juste de quoi reconnaître prod et dev. */
function hoteBase(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? "").host || "(inconnu)";
  } catch {
    return "(DATABASE_URL absente ou illisible)";
  }
}

async function main() {
  const months = entierArg("mois", MOIS_PAR_DEFAUT);
  const delayMs = entierArg("delai", DELAI_MS);

  console.log(`Base   : ${hoteBase()}`);
  console.log(`Mois   : ${months} dernières périodes publiées`);
  console.log(`Délai  : ${delayMs} ms entre deux appels squashnet`);
  console.log("Ctrl-C pour annuler — démarrage dans 5 s…\n");
  await new Promise((r) => setTimeout(r, 5_000));

  const debut = Date.now();
  const res = await backfillHistory({
    months,
    delayMs,
    onMonth: (mois, i, total, r) => {
      const min = ((Date.now() - debut) / 60_000).toFixed(1);
      console.log(
        `[${String(i).padStart(2)}/${total}] ${mois} — ${r.written} écrits, ` +
          `${r.already} déjà connus, ${r.unresolved} sans réponse, ${r.failed} en échec ` +
          `(${r.requests} requêtes, ${min} min)`,
      );
    },
  });

  console.log("\n─── Terminé ───");
  console.log(`Joueurs balayés   : ${res.subjects}`);
  console.log(`Périodes balayées : ${res.months.length}`);
  console.log(`Points écrits     : ${res.written}`);
  console.log(`Déjà connus       : ${res.already}`);
  console.log(`Sans conclusion   : ${res.unresolved}`);
  console.log(`Échecs base       : ${res.failed}`);
  console.log(`Requêtes squashnet: ${res.requests}`);
  // `unresolved` élevé n'est pas forcément une panne : un joueur licencié depuis six mois n'a
  // rien à trouver sur les mois d'avant. C'est le rapport écrits/requêtes qui alerte.
  if (res.written === 0 && res.requests > 0) {
    console.error(
      "\n⚠️  Aucun point écrit alors que squashnet a répondu : le rapprochement ne retrouve " +
        "plus personne. Vérifier le libellé du club (`YVETTE_CLUB`) et le rendu de la page.",
    );
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
