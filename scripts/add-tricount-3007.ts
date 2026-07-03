// Ajout ponctuel (démo, base DEV) : tricount du 30/07/2026.
// Chloé a payé 200 € et Bruno 100 €, chaque dépense partagée entre
// Chloé + Bruno + Thomas. Les centimes d'arrondi sont COMPENSÉS entre les deux
// dépenses (comme le fait maintenant l'API) : chacun doit 100 € pile.
// Validations de Chloé et Bruno créées → remboursements ouverts.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const host = process.env.DATABASE_URL?.match(/@([^/]+)\//)?.[1] ?? "?";
  if (!host.includes("ep-orange-art")) {
    throw new Error(`Refus : ce script ne tourne que sur la base DEV (host: ${host})`);
  }

  const bruno = await prisma.user.findUnique({ where: { contactId: "/demo/contacts/2" } });
  const chloe = await prisma.user.findUnique({ where: { contactId: "/demo/contacts/3" } });
  const thomas = await prisma.user.findFirst({
    where: { displayName: { contains: "Thomas", mode: "insensitive" } },
  });
  if (!bruno || !chloe || !thomas) {
    throw new Error(`Introuvable : bruno=${!!bruno} chloe=${!!chloe} thomas=${!!thomas}`);
  }
  const date = "2026-07-30";
  await prisma.tricount.deleteMany({ where: { date } }); // relançable

  // Arrondis compensés entre les deux dépenses :
  //   200 € : Chloé 66,67 + Bruno 66,67 + Thomas 66,66
  //   100 € : Chloé 33,33 + Bruno 33,33 + Thomas 33,34  → 100,00 € chacun.
  const t = await prisma.tricount.create({
    data: {
      date,
      title: "Sortie du 30 juillet",
      expenses: {
        create: [
          {
            payerId: chloe.id,
            creatorId: chloe.id,
            label: "Payé par Chloé",
            amountCents: 20000,
            spentAt: new Date(`${date}T12:00:00`),
            shares: {
              create: [
                { userId: chloe.id, amountCents: 6667 },
                { userId: bruno.id, amountCents: 6667 },
                { userId: thomas.id, amountCents: 6666 },
              ],
            },
          },
          {
            payerId: bruno.id,
            creatorId: bruno.id,
            label: "Payé par Bruno",
            amountCents: 10000,
            spentAt: new Date(`${date}T12:00:00`),
            shares: {
              create: [
                { userId: chloe.id, amountCents: 3333 },
                { userId: bruno.id, amountCents: 3333 },
                { userId: thomas.id, amountCents: 3334 },
              ],
            },
          },
        ],
      },
      // Les deux payeurs valident → remboursements ouverts.
      approvals: { create: [{ userId: chloe.id }, { userId: bruno.id }] },
    },
  });
  console.log(`tricount ${t.date} créé (${t.id}), remboursements ouverts.`);
  console.log("Soldes : Chloé +100,00 ; Bruno 0,00 ; Thomas −100,00.");
}

main().finally(() => prisma.$disconnect());
