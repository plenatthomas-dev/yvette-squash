// Logique du partage de frais (type Tricount). Tout est en CENTIMES (entiers) :
// les euros n'existent qu'à l'affichage, aucune arithmétique flottante ici.

/** Bornes de saisie : 1 centime à 100 000 € — largement assez pour une asso. */
export const MAX_AMOUNT_CENTS = 10_000_000;
export const MAX_LABEL_LEN = 80;
// Titre d'un tricount : court (affiché dans l'en-tête de la carte, à côté de la date).
export const MAX_TITLE_LEN = 40;
// Commentaire (idée 5a) : un message de fil de discussion attaché à un tricount.
export const MAX_COMMENT_LEN = 500;
// Mode « par parts » : nombre de parts max qu'un participant peut prendre sur une dépense.
export const MAX_PARTS = 99;

/**
 * Répartition égale de `amountCents` entre `n` participants, ajustée au centime :
 * les `amountCents % n` premiers reçoivent un centime de plus, la somme des parts
 * vaut EXACTEMENT le montant (jamais un centime perdu ou inventé).
 */
export function splitEqually(amountCents: number, n: number): number[] {
  const base = Math.floor(amountCents / n);
  const extra = amountCents % n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * Répartition égale avec mémoire des arrondis du tricount : les centimes en trop
 * vont d'abord à ceux qui ont le moins « surpayé » jusqu'ici (`credit` = somme de
 * (part attribuée − part exacte) sur les dépenses précédentes). Ainsi les erreurs
 * d'arrondi se compensent d'une dépense à l'autre : 200 € puis 100 € entre 3
 * donnent bien 100 € chacun, et non 100,01 / 100,00 / 99,99.
 * Renvoie les parts dans l'ordre de `ids`.
 */
export function splitWithCredits(
  amountCents: number,
  ids: string[],
  credit: Map<string, number>,
): number[] {
  const n = ids.length;
  const base = Math.floor(amountCents / n);
  let extra = amountCents % n;
  const order = ids
    .map((id, i) => ({ i, id, c: credit.get(id) ?? 0 }))
    .sort((a, b) => a.c - b.c || (a.id < b.id ? -1 : 1));
  const out: number[] = Array(n).fill(base);
  for (const o of order) {
    if (extra <= 0) break;
    out[o.i] = base + 1;
    extra--;
  }
  return out;
}

/**
 * Répartition PONDÉRÉE de `amountCents` selon un nombre de parts (poids entier ≥ 1) par
 * participant, `weights` aligné sur `ids`. Méthode du plus grand reste : chacun reçoit
 * floor(montant × poids / total), puis les centimes restants vont aux plus grands restes
 * fractionnaires (départage par index croissant → déterministe). La somme des parts vaut
 * EXACTEMENT le montant. Ex. 40 € avec parts [1, 2, 1] → [10, 20, 10] €.
 * Filet de sécurité : si le total des poids est nul, on retombe sur un partage égal.
 */
export function splitByWeights(
  amountCents: number,
  ids: string[],
  weights: number[],
): number[] {
  const n = ids.length;
  const totalW = weights.reduce((s, w) => s + w, 0);
  if (totalW <= 0) return splitEqually(amountCents, n);
  const exact = weights.map((w) => (amountCents * w) / totalW);
  const out = exact.map((x) => Math.floor(x));
  let remaining = amountCents - out.reduce((s, x) => s + x, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const o of order) {
    if (remaining <= 0) break;
    out[o.i] += 1;
    remaining--;
  }
  return out;
}

export interface ExpenseForBalance {
  payerId: string;
  isRefund?: boolean;
  shares: { userId: string; amountCents: number }[];
}

/**
 * Payeurs d'un tricount = ceux qui ont réglé au moins une VRAIE dépense (pas un
 * remboursement). Ce sont eux qui doivent tous valider avant les remboursements.
 */
export function payersOf(expenses: ExpenseForBalance[]): string[] {
  return [...new Set(expenses.filter((e) => !e.isRefund).map((e) => e.payerId))];
}

/**
 * Solde net par joueur : + ce qu'il a avancé, − ce qu'il doit.
 * Positif = le groupe lui doit de l'argent ; négatif = il doit au groupe.
 * La somme de tous les soldes vaut toujours 0.
 */
export function computeBalances(expenses: ExpenseForBalance[]): Map<string, number> {
  const bal = new Map<string, number>();
  const add = (userId: string, cents: number) =>
    bal.set(userId, (bal.get(userId) ?? 0) + cents);
  for (const e of expenses) {
    for (const s of e.shares) {
      add(e.payerId, s.amountCents);
      add(s.userId, -s.amountCents);
    }
  }
  return bal;
}

export interface Transfer {
  fromId: string;
  toId: string;
  amountCents: number;
}

/**
 * Suggestion de remboursements « qui rend combien à qui » : glouton, le plus gros
 * débiteur paie le plus gros créancier jusqu'à épuisement. Au plus n−1 virements.
 * Tri secondaire par id pour un résultat déterministe entre deux appels.
 */
export function settle(balances: Map<string, number>): Transfer[] {
  const creditors = [...balances].filter(([, c]) => c > 0);
  const debtors = [...balances].filter(([, c]) => c < 0);
  const byAmount = (a: [string, number], b: [string, number]) =>
    Math.abs(b[1]) - Math.abs(a[1]) || (a[0] < b[0] ? -1 : 1);
  creditors.sort(byAmount);
  debtors.sort(byAmount);

  const out: Transfer[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const owe = -debtors[i][1];
    const due = creditors[j][1];
    const pay = Math.min(owe, due);
    out.push({ fromId: debtors[i][0], toId: creditors[j][0], amountCents: pay });
    debtors[i][1] += pay;
    creditors[j][1] -= pay;
    if (debtors[i][1] === 0) i++;
    if (creditors[j][1] === 0) j++;
  }
  return out;
}
