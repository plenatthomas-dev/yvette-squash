import { prisma } from "./db";

// MON SOLDE SUR TOUT L'HISTORIQUE — indépendant de la pagination.
//
// POURQUOI CE MODULE EXISTE
// L'en-tête de l'onglet Frais annonce « Tu dois X au total », et le badge € du menu compte les
// tricounts où l'on doit de l'argent. Les deux se calculaient sur la LISTE REÇUE, c'est-à-dire
// sur les 25 tricounts de la première page. Au rythme du club — trois soirées par semaine —
// 25 tricounts font deux mois : une dette plus ancienne sortait de la fenêtre, et l'en-tête
// affichait « Tu es à l'équilibre 👌 » à quelqu'un qui devait toujours 42 €. Le badge
// disparaissait avec elle. Rien ne signalait que « au total » voulait dire « sur les 25
// derniers » — et le bouton « Charger l'historique plus ancien » ne dit pas qu'il change le
// total.
//
// LE CALCUL, ET POURQUOI IL EST EXACT SANS TOUT CHARGER
// Mon solde sur un tricount = ce que j'ai avancé − ce que je dois. Deux requêtes ÉTROITES
// suffisent : les dépenses dont je suis le payeur, et les parts qui portent mon nom. On ne
// charge ni les dépenses des autres, ni les commentaires, ni les invités — là où la route de
// liste ramène quatre niveaux d'inclusion pour l'affichage.
//
// Sommer sur TOUS les tricounts donne bien le total : un tricount soldé a, par définition, tous
// ses soldes à zéro (c'est ce que « soldé » veut dire), il n'ajoute donc rien. On n'a pas besoin
// de savoir lesquels sont soldés pour que la somme soit juste.

export interface TricountSummary {
  /** Mon solde, tous tricounts confondus. Négatif = je dois. */
  globalCents: number;
  /** Combien de tricounts attendent un remboursement DE MA PART (le badge €). */
  owedCount: number;
}

/** Mon solde par tricount : ce que j'ai avancé moins ce que je dois. */
async function balanceParTricount(userId: string): Promise<Map<string, number>> {
  const [avances, parts] = await Promise.all([
    prisma.expense.findMany({
      where: { payerId: userId },
      select: { tricountId: true, amountCents: true },
    }),
    prisma.expenseShare.findMany({
      where: { userId },
      select: { amountCents: true, expense: { select: { tricountId: true } } },
    }),
  ]);
  const solde = new Map<string, number>();
  for (const e of avances) solde.set(e.tricountId, (solde.get(e.tricountId) ?? 0) + e.amountCents);
  for (const s of parts) {
    const t = s.expense.tricountId;
    solde.set(t, (solde.get(t) ?? 0) - s.amountCents);
  }
  return solde;
}

/**
 * Le total dû, et le nombre de tricounts qui attendent un remboursement de ma part.
 *
 * Le second chiffre exige de savoir si les remboursements sont OUVERTS (tous les payeurs ont
 * validé) : cette question-là ne se pose que pour les tricounts où je suis à découvert, donc on
 * ne va chercher payeurs et validations que pour CEUX-LÀ. En pratique, une poignée.
 */
export async function tricountSummary(userId: string): Promise<TricountSummary> {
  const soldes = await balanceParTricount(userId);
  const globalCents = [...soldes.values()].reduce((s, c) => s + c, 0);

  const enDette = [...soldes].filter(([, cents]) => cents < 0).map(([id]) => id);
  if (enDette.length === 0) return { globalCents, owedCount: 0 };

  const [payeurs, validations] = await Promise.all([
    // Les payeurs d'un tricount : les auteurs de ses VRAIES dépenses (un remboursement ne
    // fait de personne un payeur, et un invité n'est jamais payeur d'une vraie dépense).
    prisma.expense.findMany({
      where: { tricountId: { in: enDette }, isRefund: false, payerId: { not: null } },
      select: { tricountId: true, payerId: true },
      distinct: ["tricountId", "payerId"],
    }),
    prisma.tricountApproval.findMany({
      where: { tricountId: { in: enDette } },
      select: { tricountId: true, userId: true },
    }),
  ]);

  const payeursDe = new Map<string, Set<string>>();
  for (const p of payeurs) {
    const set = payeursDe.get(p.tricountId) ?? new Set<string>();
    set.add(p.payerId as string);
    payeursDe.set(p.tricountId, set);
  }
  const validesDe = new Map<string, Set<string>>();
  for (const a of validations) {
    const set = validesDe.get(a.tricountId) ?? new Set<string>();
    set.add(a.userId);
    validesDe.set(a.tricountId, set);
  }

  const owedCount = enDette.filter((id) => {
    const payers = payeursDe.get(id);
    // Sans payeur, rien à rembourser — même règle que la route de liste (`ready`).
    if (!payers || payers.size === 0) return false;
    const approved = validesDe.get(id) ?? new Set<string>();
    return [...payers].every((p) => approved.has(p));
  }).length;

  return { globalCents, owedCount };
}
