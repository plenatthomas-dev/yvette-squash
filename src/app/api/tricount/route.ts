import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import {
  computeBalances,
  settle,
  payersOf,
  isReady,
  toKeyedExpense,
  userKey,
  guestKey,
  parseKey,
} from "@/lib/tricount";
import { getFeatures } from "@/lib/features-server";
import { tricountSummary } from "@/lib/tricount-summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/tricount -> l'historique complet : un tricount par jour, chacun avec ses
// dépenses, ses soldes, ses remboursements suggérés et l'état des validations
// (« OK pour rembourser ») de ses payeurs. Ordre d'affichage : les tricounts EN COURS
// d'abord (plus récent en tête), puis les tricounts ÉQUILIBRÉS en bas.
export async function GET(req: NextRequest) {
  if (!(await getFeatures()).tricount) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  // Pagination : on ne renvoie jamais TOUT l'historique d'un coup (il grossit sans fin).
  // ?limit borne le nombre de tricounts (les plus récents d'abord) ; le client demande
  // simplement un limit plus grand pour « charger plus » — ce qui préserve le tri global
  // (en cours en haut, équilibrés en bas) fait ensuite sur la fenêtre renvoyée.
  const DEFAULT_LIMIT = 25;
  const MAX_LIMIT = 200;
  const rawLimit = Number(req.nextUrl.searchParams.get("limit"));
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
      : DEFAULT_LIMIT;

  const [users, rows, summary] = await Promise.all([
    // TOUS les comptes, y compris désactivés : ils servent à NOMMER les parts déjà écrites.
    // Un compte désactivé qui disparaîtrait d'ici ferait afficher « ? » à la place de son nom
    // sur toutes les dépenses passées — on ne réécrit pas l'historique d'argent. Ce sont les
    // membres PROPOSABLES qui sont filtrés plus bas.
    prisma.user.findMany({
      select: { id: true, displayName: true, disabledAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.tricount.findMany({
      // Un tricount SANS AUCUNE DÉPENSE n'est pas encore une soirée partagée, c'est un
      // brouillon : la route « invités » en crée un dès qu'on tape un prénom, avant même la
      // première dépense. Saisir un invité puis renoncer laissait donc une carte vide « En
      // cours » en tête de liste, chez tout le monde, que rien ne pouvait effacer — le seul
      // chemin de suppression côté membre passe par la dernière dépense, et il n'y en avait
      // jamais eu. Elle réapparaît d'elle-même à la première dépense.
      where: { expenses: { some: {} } },
      include: {
        expenses: {
          include: {
            shares: { select: { userId: true, guestId: true, amountCents: true } },
          },
          orderBy: [{ isRefund: "asc" }, { spentAt: "asc" }],
        },
        approvals: { select: { userId: true } },
        comments: {
          select: { id: true, body: true, userId: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        },
        guests: { select: { id: true, name: true } },
      },
      orderBy: { date: "desc" },
      take: limit + 1, // +1 pour savoir s'il reste des tricounts plus anciens
    }),
    // Mon solde sur TOUT l'historique, et le nombre de tricounts qui attendent un
    // remboursement de ma part. Calculés à part, par des requêtes étroites : les deux chiffres
    // se déduisaient de la liste renvoyée, donc des 25 derniers tricounts seulement — une
    // dette plus ancienne disparaissait du total ET du badge, sans que rien ne le dise.
    tricountSummary(session.userId),
  ]);
  // S'il y a une ligne de trop, c'est qu'il reste de l'historique : on la retire.
  const hasMore = rows.length > limit;
  const tricounts = hasMore ? rows.slice(0, limit) : rows;

  // Tricount : on affiche TOUJOURS le prénom/nom réel (displayName), jamais le pseudo —
  // pour savoir sans ambiguïté qui a payé quoi et à qui rendre l'argent. Membres et
  // invités hors asso partagent le même Map, sous des clés préfixées (u:/g:) pour ne
  // jamais les confondre ; le nom d'un invité porte le suffixe "(ext)" (jamais stocké).
  const nameOf = new Map<string, string>();
  for (const u of users) nameOf.set(userKey(u.id), u.displayName);
  for (const t of tricounts) {
    for (const g of t.guests) nameOf.set(guestKey(g.id), `${g.name} (ext)`);
  }
  const name = (key: string) => nameOf.get(key) ?? "?";

  return NextResponse.json({
    me: session.userId,
    // Compte « email seul » (sans ResaMania) : l'IHM masque alors la gestion des
    // dépenses (création/édition/suppression). Lecture, remboursements, messagerie
    // et validation restent possibles. Le serveur reste la source de vérité (403).
    emailOnly: session.resa === null,
    // Reste-t-il des tricounts plus anciens à charger ? (bouton « Charger plus »)
    hasMore,
    // Mon solde et mon nombre de dettes sur TOUT l'historique — indépendants de `limit`, donc
    // justes même quand la dette dort dans un tricount hors fenêtre. L'en-tête affiche le
    // premier, le badge € compte le second.
    myGlobalCents: summary.globalCents,
    myOwedCount: summary.owedCount,
    // Les membres PROPOSABLES dans « Payé par » et « Pour qui ? ». Un compte désactivé par un
    // admin n'a plus rien à faire dans un sélecteur : il ne peut plus se connecter, donc ni
    // valider, ni rembourser — l'y aligner créerait une dette que personne ne pourra solder.
    //
    // ⚠️ Le retrait de l'ANNUAIRE ne filtre PAS ici, et c'est un choix : le Tricount affiche
    // toujours le nom réel (jamais le pseudo) parce qu'il faut savoir sans ambiguïté à qui
    // rendre l'argent. Se retirer de l'annuaire dit « ne me proposez pas aux autres pour
    // jouer », pas « ne partagez plus de frais avec moi ». Les deux finalités sont distinctes,
    // et celle-ci est décrite dans la note de confidentialité (paragraphe « Partage de frais »).
    members: users
      .filter((u) => u.disabledAt === null)
      .map((u) => ({ id: u.id, name: u.displayName, fullName: u.displayName })),
    tricounts: tricounts
      .map((t) => {
      const keyedExpenses = t.expenses.map(toKeyedExpense);
      const balances = computeBalances(keyedExpenses);
      const transfers = settle(balances);
      // Un invité n'est jamais payeur d'une vraie dépense : payersOf ne renvoie que
      // des clés membre ("u:xxx").
      const payers = payersOf(keyedExpenses).map((k) => parseKey(k).id);
      const approved = new Set(t.approvals.map((a) => a.userId));
      // La règle vit dans `isReady` : les routes d'écriture s'en servent aussi, désormais
      // qu'elles refusent de rouvrir un tricount soldé.
      const ready = isReady(payers, approved);
      const settled = ready && transfers.length === 0;
      return {
        id: t.id,
        date: t.date,
        title: t.title,
        totalCents: t.expenses
          .filter((e) => !e.isRefund)
          .reduce((s, e) => s + e.amountCents, 0),
        ready,
        settled,
        payers: payers.map((p) => ({
          id: p,
          name: name(userKey(p)),
          approved: approved.has(p),
        })),
        guests: t.guests.map((g) => ({ id: g.id, name: `${g.name} (ext)` })),
        expenses: t.expenses.map((e) => {
          const mine = e.creatorId === session.userId || e.payerId === session.userId;
          const payerKey = e.payerId ? userKey(e.payerId) : guestKey(e.payerGuestId as string);
          return {
            id: e.id,
            label: e.label,
            amountCents: e.amountCents,
            isRefund: e.isRefund,
            spentAt: e.spentAt.toISOString(),
            payerId: e.payerId ?? e.payerGuestId,
            payerKind: e.payerId ? "user" : "guest",
            payerName: name(payerKey),
            participants: e.shares.map((s) => {
              const key = s.userId ? userKey(s.userId) : guestKey(s.guestId as string);
              const p = parseKey(key);
              return { id: p.id, kind: p.kind, name: name(key) };
            }),
            canDelete: mine,
            // Édition réservée aux vraies dépenses (un remboursement se supprime/refait).
            canEdit: mine && !e.isRefund,
          };
        }),
        balances: [...balances]
          .map(([key, cents]) => {
            const p = parseKey(key);
            return { id: p.id, kind: p.kind, name: name(key), cents };
          })
          .sort((a, b) => b.cents - a.cents),
        transfers: transfers.map((tr) => {
          const from = parseKey(tr.fromId);
          const to = parseKey(tr.toId);
          return {
            fromId: from.id,
            fromKind: from.kind,
            fromName: name(tr.fromId),
            toId: to.id,
            toKind: to.kind,
            toName: name(tr.toId),
            amountCents: tr.amountCents,
          };
        }),
        // Fil de commentaires (idée 5a). On affiche le nom réel (comme le reste du tricount),
        // jamais le pseudo ; chacun ne peut supprimer que ses propres messages.
        comments: t.comments.map((c) => ({
          id: c.id,
          body: c.body,
          userId: c.userId,
          userName: name(userKey(c.userId)),
          createdAt: c.createdAt.toISOString(),
          canDelete: c.userId === session.userId,
        })),
      };
      })
      // Équilibrés en bas ; à statut égal, le plus récent en premier (date desc).
      .sort(
        (a, b) => Number(a.settled) - Number(b.settled) || (a.date < b.date ? 1 : -1),
      ),
  });
}
