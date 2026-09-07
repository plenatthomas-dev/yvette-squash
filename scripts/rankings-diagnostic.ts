/**
 * DIAGNOSTIC DE L'HISTORIQUE DU CLASSEMENT — « pourquoi ce joueur n'a-t-il qu'une mesure ? »
 *
 * Deux modes, du général au particulier.
 *
 * ─── 1. L'ÉTAT DE LA BASE (aucun appel réseau, instantané) ───────────────────
 *
 *   node --env-file=.env --import tsx scripts/rankings-diagnostic.ts
 *
 * Imprime, pour chaque joueur balayé, combien de mesures il porte et sur quelle plage — plus la
 * couverture mois par mois. C'est ce tableau qui nomme la panne :
 *
 *   • TOUT LE MONDE À 1, un seul joueur au-dessus → le remplissage rétroactif n'a jamais tourné
 *     pour les autres. Leur unique mesure est celle du mois courant, écrite par la passe
 *     mensuelle. Cause la plus fréquente : le backfill a tourné quand l'effectif était plus
 *     petit (ou avant que les autres ne soient `listed` / alignés en équipe), et personne ne
 *     l'a relancé depuis. Correctif : « Compléter l'historique » dans /admin, jusqu'à zéro
 *     restant — les mesures déjà là ne sont jamais redemandées.
 *   • TOUT LE MONDE À 0 SAUF QUELQUES-UNS, sur des plages irrégulières → c'est le
 *     RAPPROCHEMENT qui échoue, pas le remplissage. Passer au mode 2 sur un joueur à 1 mesure.
 *   • UNE COUPURE NETTE À LA MÊME DATE POUR TOUS → la fédération ne publie pas plus loin
 *     (vérifier avec `npm run rankings:mois`).
 *
 * ─── 2. LE VERDICT LIVE POUR UN JOUEUR ET UN MOIS ────────────────────────────
 *
 *   node --env-file=.env --import tsx scripts/rankings-diagnostic.ts "Dupont" 2026-01-05
 *
 * Rejoue EXACTEMENT ce que fait le remplissage pour ce joueur ce mois-là — le terme de
 * recherche envoyé, les lignes reçues, et le verdict — puis l'explique. Aucune écriture : on
 * regarde, on ne corrige rien.
 *
 * C'est ce mode qui débusque la panne silencieuse que le schéma documente déjà : quand
 * ResaMania a enregistré « Nom Prénom », le terme cherché est un PRÉNOM, la réponse déborde de
 * homonymes, et le verdict est « introuvable » tous les mois sans que rien ne le signale. Le
 * correctif est alors `squashnetGivenName` / `squashnetFamilyName` sur le membre.
 */
import { prisma } from "../src/lib/db";
import { getMonths, searchRanking } from "../src/lib/squashnet/client";
import { classifyRanking, YVETTE_CLUB, normalize } from "../src/lib/squashnet/match";
import { subjectsToRefresh } from "../src/lib/squashnet/refresh";

/** « 2026-01-05 » → « janv. 26 », pour tenir dans une colonne. */
const court = (m: string) => `${m.slice(5, 7)}/${m.slice(2, 4)}`;

async function etatDeLaBase() {
  const [subjects, points] = await Promise.all([
    subjectsToRefresh(),
    prisma.squashnetRankingPoint.findMany({
      select: { userId: true, guestId: true, month: true },
      orderBy: { month: "asc" },
    }),
  ]);

  // Les mesures par joueur, indexées comme le remplissage les écrit.
  const parJoueur = new Map<string, string[]>();
  for (const p of points) {
    const cle = p.userId ? `member:${p.userId}` : `guest:${p.guestId}`;
    parJoueur.set(cle, [...(parJoueur.get(cle) ?? []), p.month]);
  }

  console.log(`\n${subjects.length} joueur(s) balayé(s), ${points.length} mesure(s) en base.\n`);
  console.log("  Mesures  Plage                  Joueur");
  console.log("  ───────  ─────────────────────  ──────────────────────────");
  // Les moins mesurés EN TÊTE : ce sont eux le sujet du diagnostic.
  const lignes = subjects
    .map((s) => ({ s, mois: parJoueur.get(`${s.kind}:${s.id}`) ?? [] }))
    .sort((a, b) => a.mois.length - b.mois.length || a.s.name.localeCompare(b.s.name, "fr"));
  for (const { s, mois } of lignes) {
    const plage = mois.length
      ? `${court(mois[0])} → ${court(mois[mois.length - 1])}`.padEnd(21)
      : "—".padEnd(21);
    const marque = s.kind === "guest" ? " (hors appli)" : "";
    console.log(`  ${String(mois.length).padStart(7)}  ${plage}  ${s.name}${marque}`);
  }

  // La couverture par mois : c'est elle qui distingue « la source s'arrête là » (une coupure
  // franche, tout le monde ensemble) de « le remplissage n'a pas fini » (une marche d'escalier).
  const parMois = new Map<string, number>();
  for (const p of points) parMois.set(p.month, (parMois.get(p.month) ?? 0) + 1);
  console.log("\n  Couverture par période (nombre de joueurs mesurés) :\n");
  for (const [mois, n] of [...parMois.entries()].sort()) {
    const barre = "█".repeat(Math.min(40, n));
    console.log(`  ${mois}  ${String(n).padStart(3)}  ${barre}`);
  }

  const publies = await getMonths().catch(() => [] as string[]);
  if (publies.length) {
    const manquants = publies.filter((m) => !parMois.has(m));
    console.log(
      `\n  squashnet publie ${publies.length} période(s), de ${publies[publies.length - 1]} ` +
        `à ${publies[0]}.`,
    );
    if (manquants.length) {
      console.log(
        `  ${manquants.length} n'ont AUCUNE mesure en base : ${manquants.slice(0, 8).join(", ")}` +
          `${manquants.length > 8 ? "…" : ""}`,
      );
      console.log("  → « Compléter l'historique » (/admin) n'a pas fini son travail.");
    } else {
      console.log("  Toutes ont au moins une mesure : la source est couverte de bout en bout.");
      console.log("  → si un joueur reste à 1 mesure, c'est SON rapprochement qui échoue (mode 2).");
    }
  }
}

async function verdictLive(motCle: string, moisVoulu?: string) {
  const subjects = await subjectsToRefresh();
  const cible = subjects.filter((s) => normalize(s.name).includes(normalize(motCle)));
  if (cible.length === 0) {
    console.error(`Aucun joueur balayé ne correspond à « ${motCle} ».`);
    console.error("Rappel : ne sont balayés que les membres `listed` OU alignés en équipe.");
    process.exitCode = 1;
    return;
  }

  const publies = await getMonths();
  // Par défaut, la période la PLUS ANCIENNE : c'est là que le rapprochement échoue, jamais sur
  // le mois courant (que la passe mensuelle a déjà su écrire).
  const month = moisVoulu ?? publies[publies.length - 1];
  if (!month) {
    console.error("squashnet ne publie aucune période.");
    process.exitCode = 1;
    return;
  }

  for (const s of cible) {
    console.log(`\n─── ${s.name} — période ${month} ───`);
    console.log(`  Terme envoyé à squashnet : « ${s.query} »`);
    console.log(
      `  Identité à retrouver     : prénom « ${s.identity.givenName || "(vide)"} », ` +
        `nom « ${s.identity.familyName} »`,
    );

    const rows = await searchRanking(s.query, { month });
    console.log(`  Lignes reçues            : ${rows.length}`);
    for (const r of rows.slice(0, 12)) {
      const chezNous = normalize(r.club) === normalize(YVETTE_CLUB) ? " ← notre club" : "";
      console.log(`    · ${r.name.padEnd(28)} ${r.clt.padEnd(4)} ${r.club}${chezNous}`);
    }
    if (rows.length > 12) console.log(`    … et ${rows.length - 12} autres`);

    const v = classifyRanking(s.identity, rows);
    console.log(`  VERDICT                  : ${v.status}`);
    if (v.status === "matched") {
      console.log(`  → rapproché : ${v.match.clt}, rang mixte ${v.match.rangM}, moyenne ${v.match.mean}`);
      console.log("  → une mesure SERAIT écrite pour ce mois. Si elle manque en base, c'est que");
      console.log("    le remplissage n'est pas passé ici : relancer « Compléter l'historique ».");
    } else if (v.status === "moved") {
      console.log("  → le joueur est retrouvé, mais dans un AUTRE club à cette période.");
      console.log("    Aucune mesure n'est écrite, et c'est volontaire : il ne jouait pas encore");
      console.log("    pour l'Yvette ce mois-là. Rien à corriger.");
    } else {
      console.log("  → introuvable, ou plusieurs lignes ambiguës dans le club.");
      console.log("    Causes usuelles, dans l'ordre :");
      console.log("      1. le terme cherché est un PRÉNOM (ResaMania a enregistré « Nom Prénom »)");
      console.log("         → renseigner squashnetGivenName / squashnetFamilyName sur le membre ;");
      console.log("      2. orthographe divergente entre ResaMania et la fédération (même remède) ;");
      console.log("      3. joueur pas encore licencié à cette période → rien à corriger.");
    }
  }
}

async function main() {
  const [motCle, mois] = process.argv.slice(2);
  if (motCle) await verdictLive(motCle, mois);
  else await etatDeLaBase();
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
