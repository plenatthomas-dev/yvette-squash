import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { payersOf, computeBalances, toKeyedExpense, parseKey } from "@/lib/tricount";
import { pushToUser } from "@/lib/push";
import { getFeatures } from "@/lib/features-server";
import { httpErrorResponse, serializableTransaction } from "@/lib/http-tx";

export const runtime = "nodejs";

/** "2026-07-09" -> "jeudi 9 juillet" (format français). */
function prettyDate(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/** 1234 -> "12,34 €". */
function fmtEuros(cents: number): string {
  return (
    (cents / 100).toLocaleString("fr-FR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + " €"
  );
}

// POST /api/tricount/{id}/approve -> le joueur connecté (qui doit être un payeur
// du tricount) donne son « OK pour lancer les remboursements ». Quand tous les
// payeurs ont validé, les remboursements s'ouvrent. À CE MOMENT-LÀ (et seulement à
// la transition), on notifie par push les débiteurs — ceux qui doivent rembourser —
// pour les prévenir qu'ils peuvent régler (l'utilisateur qui valide n'est pas notifié).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await getFeatures()).tricount) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { id } = await params;
  const tricount = await prisma.tricount.findUnique({
    where: { id },
    include: {
      expenses: {
        include: {
          shares: { select: { userId: true, guestId: true, amountCents: true } },
        },
      },
      approvals: { select: { userId: true } },
    },
  });
  if (!tricount) {
    return NextResponse.json({ error: "Tricount introuvable" }, { status: 404 });
  }
  const keyedExpenses = tricount.expenses.map(toKeyedExpense);
  // Un invité n'est jamais payeur d'une vraie dépense : payersOf ne renvoie que des
  // clés membre ("u:xxx"), qu'on dépréfixe pour matcher TricountApproval.userId.
  const payers = payersOf(keyedExpenses).map((k) => parseKey(k).id);
  if (!payers.includes(session.userId)) {
    return NextResponse.json(
      { error: "Seuls les payeurs de ce tricount valident" },
      { status: 403 },
    );
  }

  // TRANSITION « REMBOURSEMENTS OUVERTS » — décidée sur le RÉSULTAT de l'écriture, dans la
  // même transaction, et jamais sur une lecture faite avant.
  //
  // Elle se déduisait de `tricount.approvals`, lu plus haut, hors transaction. Deux exécutions
  // concurrentes voyaient donc le même état de départ, avec deux issues également fausses :
  //
  //   * DEUX PAYEURS QUI VALIDENT AU MÊME INSTANT — chacun lit « aucune validation », et la
  //     transition exige que l'AUTRE soit déjà là : les deux répondent « pas encore prêt ».
  //     Les deux écritures passent, le tricount devient prêt, et PERSONNE n'est jamais
  //     prévenu. C'est la panne la plus coûteuse : tout le monde attend une notification qui
  //     ne partira plus.
  //   * UN REJEU (réponse perdue, requête rejouée par le client) — les deux exécutions lisent
  //     le même état d'avant et annoncent deux fois la même ouverture, à tous les débiteurs.
  //
  // Deux conditions, relues APRÈS l'écriture, dans une transaction Serializable :
  //   1. ma validation n'existait pas avant — sinon c'est un rejeu, il n'ouvre rien ;
  //   2. toutes les validations sont là.
  //
  // Le Serializable est LOAD-BEARING, ce n'est pas une précaution de style. Deux validations
  // simultanées lisent l'ensemble des validations ET y insèrent une ligne : c'est un
  // write-skew, que Postgres détecte (40001) et que la boucle de `serializableTransaction`
  // rejoue. Le rejeu voit alors les deux lignes, et la seconde transaction constate que sa
  // propre validation existe déjà — exactement une des deux annonce.
  //
  // Le contrôle « existait déjà » remplace un marqueur persistant, et c'est délibéré : un
  // tricount se REFERME légitimement (ajouter une dépense oubliée remet les validations à
  // zéro), et rouvre ensuite sur un MONTANT DIFFÉRENT. Cette seconde ouverture doit être
  // annoncée, ce qu'un marqueur qui ne se réarme pas aurait interdit. Ici la ligne de
  // validation a été supprimée avec les autres : la condition redevient vraie d'elle-même.
  //
  // ⚠️ Le corps est rejoué tel quel en cas de conflit de sérialisation : aucun envoi de
  // notification ne doit s'y trouver. Il rend ce qu'il faut annoncer ; l'envoi part après le
  // commit (même règle que l'interclub, cf. `http-tx.ts`).
  let doitAnnoncer = false;
  try {
    doitAnnoncer = await serializableTransaction(async (tx) => {
      // Ma validation existait-elle DÉJÀ ? Si oui, ce clic n'ouvre rien : c'est une
      // revalidation ou un rejeu, et il ne doit rien annoncer.
      const dejaValide = await tx.tricountApproval.findUnique({
        where: { tricountId_userId: { tricountId: id, userId: session.userId } },
        select: { userId: true },
      });
      await tx.tricountApproval.upsert({
        where: { tricountId_userId: { tricountId: id, userId: session.userId } },
        update: {},
        create: { tricountId: id, userId: session.userId },
      });
      const apres = await tx.tricountApproval.findMany({
        where: { tricountId: id },
        select: { userId: true },
      });
      const approuves = new Set(apres.map((a) => a.userId));
      return !dejaValide && payers.every((p) => approuves.has(p));
    }, "Validation concurrente, réessaie");
  } catch (e) {
    const res = httpErrorResponse(e);
    if (res) return res;
    throw e;
  }

  if (doitAnnoncer) {
    // Débiteurs = solde négatif ; on prévient chacun (sauf soi) du montant à rendre.
    // Un invité peut être débiteur mais n'a pas de souscription push (pas de
    // compte) : on ne notifie que les clés membre.
    const balances = computeBalances(keyedExpenses);
    const debtors = [...balances]
      .map(([key, cents]) => ({ ...parseKey(key), cents }))
      .filter((d) => d.kind === "user" && d.cents < 0 && d.id !== session.userId);
    await Promise.all(
      debtors.map(({ id: userId, cents }) =>
        pushToUser(userId, {
          title: "Remboursements ouverts 💸",
          body: `Tricount du ${prettyDate(tricount.date)} : tu dois ${fmtEuros(-cents)}.`,
          url: "/?view=money",
          tag: `tricount-ready-${id}`,
          // Sans `renotify`, une notification qui en REMPLACE une autre de même tag échange
          // son contenu SANS alerter : ni son, ni vibration. Or un tricount rouvert après
          // correction porte un MONTANT DIFFÉRENT — le débiteur ne saurait pas qu'il a
          // changé, et pourrait rembourser l'ancien. Tous les autres émetteurs du dépôt
          // posent ce drapeau.
          renotify: true,
        }),
      ),
    );
  }

  return NextResponse.json({ ok: true });
}
