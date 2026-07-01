/**
 * Test live de l'adaptateur ResaMania : login -> getPlanning (lecture seule).
 *
 * Usage :
 *   node --env-file=.env --import tsx scripts/resa-test.ts
 * avec RESA_TEST_USER / RESA_TEST_PASS dans l'environnement.
 */
import { login, getPlanning } from "../src/lib/resamania/client";

async function main() {
  const username = process.env.RESA_TEST_USER;
  const password = process.env.RESA_TEST_PASS;
  if (!username || !password) {
    throw new Error("RESA_TEST_USER / RESA_TEST_PASS requis dans l'environnement");
  }

  console.log("→ login()…");
  const session = await login({ username, password });
  console.log("  OK :", {
    nom: `${session.identity.givenName} ${session.identity.familyName}`,
    contactId: session.identity.contactId,
    contactNumber: session.identity.contactNumber,
    expireDansMin: Math.round((session.expiresAt - Date.now()) / 60000),
  });

  const date = new Date().toISOString().slice(0, 10);
  console.log(`→ getPlanning(${date})…`);
  const p = await getPlanning(date, session.accessToken);
  console.log(
    `  ${p.courts.length} courts, ${p.slots.length} créneaux, ` +
      `${p.slots.filter((s) => s.bookable).length} libres`,
  );
  console.log("  courts :", p.courts.map((c) => c.name).join(", "));
  const withId = p.slots.filter((s) => s.id).length;
  console.log(`  créneaux avec @id : ${withId}/${p.slots.length}`);
  console.log("  exemple id 1er créneau :", p.slots[0]?.id);
}

main().catch((e) => {
  console.error("ÉCHEC :", e.message);
  process.exit(1);
});
