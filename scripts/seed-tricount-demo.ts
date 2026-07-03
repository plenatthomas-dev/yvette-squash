// Seed de démonstration pour l'onglet « Frais » (base Neon DEV uniquement).
// 3 membres factices (contactId /demo/... → nettoyage facile) + 2 tricounts :
//   - hier : « Matériel » (balles + grips), validations INCOMPLÈTES → montre
//     l'étape « en attente des payeurs » ;
//   - aujourd'hui : « Repas » (repas 200 € par Chloé pour Thomas+Alice, divers
//     300 € par Bruno pour Bruno+Thomas), payeurs factices déjà validés →
//     remboursements OUVERTS, testables depuis le compte réel.
// Relançable : il repart de zéro (tricounts de démo supprimés puis recréés).
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString("en-CA");
};

async function main() {
  const host = process.env.DATABASE_URL?.match(/@([^/]+)\//)?.[1] ?? "?";
  if (!host.includes("ep-orange-art")) {
    throw new Error(`Refus : ce script ne tourne que sur la base DEV (host: ${host})`);
  }

  const demo = [
    { contactId: "/demo/contacts/1", displayName: "Alice Martin" },
    { contactId: "/demo/contacts/2", displayName: "Bruno Durand" },
    { contactId: "/demo/contacts/3", displayName: "Chloé Petit" },
  ];
  const ids: string[] = [];
  for (const d of demo) {
    const u = await prisma.user.upsert({
      where: { contactId: d.contactId },
      update: {},
      create: d,
    });
    ids.push(u.id);
    console.log("membre :", u.displayName, u.id);
  }
  const [alice, bruno, chloe] = ids;

  const thomas = await prisma.user.findFirst({
    where: { displayName: { contains: "Thomas", mode: "insensitive" } },
  });
  if (!thomas) throw new Error("Compte réel Thomas introuvable dans la base dev");

  const yesterday = day(-1);
  const today = day(0);

  // Repart de zéro (cascade : dépenses, parts, validations).
  await prisma.tricount.deleteMany({ where: { date: { in: [yesterday, today] } } });

  // --- Tricount d'HIER : matériel, validations incomplètes ---
  await prisma.tricount.create({
    data: {
      date: yesterday,
      title: "Matériel",
      expenses: {
        create: [
          {
            payerId: alice,
            creatorId: alice,
            label: "Balles double point jaune",
            amountCents: 2400,
            spentAt: new Date(`${yesterday}T12:00:00`),
            shares: {
              create: ids.map((userId) => ({ userId, amountCents: 800 })),
            },
          },
          {
            payerId: bruno,
            creatorId: bruno,
            label: "Grips",
            amountCents: 999,
            spentAt: new Date(`${yesterday}T12:00:00`),
            shares: {
              create: [
                { userId: bruno, amountCents: 500 },
                { userId: chloe, amountCents: 499 },
              ],
            },
          },
        ],
      },
      // Alice a validé, pas Bruno → remboursements verrouillés (étape visible).
      approvals: { create: [{ userId: alice }] },
    },
  });
  console.log(`tricount « Matériel » (${yesterday}) : en attente de Bruno.`);

  // --- Tricount d'AUJOURD'HUI : repas, payeurs factices déjà OK ---
  await prisma.tricount.create({
    data: {
      date: today,
      title: "Repas",
      expenses: {
        create: [
          {
            payerId: chloe,
            creatorId: chloe,
            label: "Repas",
            amountCents: 20000,
            spentAt: new Date(`${today}T12:00:00`),
            shares: {
              create: [
                { userId: thomas.id, amountCents: 10000 },
                { userId: alice, amountCents: 10000 },
              ],
            },
          },
          {
            payerId: bruno,
            creatorId: bruno,
            label: "Divers",
            amountCents: 30000,
            spentAt: new Date(`${today}T12:00:00`),
            shares: {
              create: [
                { userId: bruno, amountCents: 15000 },
                { userId: thomas.id, amountCents: 15000 },
              ],
            },
          },
        ],
      },
      // Les deux payeurs (factices) ont validé → remboursements ouverts.
      approvals: { create: [{ userId: chloe }, { userId: bruno }] },
    },
  });
  console.log(`tricount « Repas » (${today}) : remboursements ouverts.`);
  console.log("Attendu aujourd'hui : Chloé +200 ; Bruno +150 ; Thomas −250 ; Alice −100.");
}

main().finally(() => prisma.$disconnect());
