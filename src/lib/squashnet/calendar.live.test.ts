import { describe, it, expect } from "vitest";
import { fetchTeamCalendar, ownFixtures } from "./calendar";

// SONDE MANUELLE — appel réseau RÉEL à squashnet, volontairement SKIPPÉE.
//
// Pourquoi elle existe : le 2026-08-26, squashnet a basculé tout son HTML d'attributs des
// guillemets simples aux doubles sans rien changer d'autre, et le parsing du classement a cassé
// net — en silence, l'écran affichant « indisponible » alors que le site était debout. Les
// fixtures de `calendar.test.ts` figent le format d'AUJOURD'HUI ; elles ne peuvent pas prévenir
// qu'il a changé. C'est ce que fait cette sonde, à la demande.
//
// Pourquoi elle est skippée : `npm test` doit tourner sans réseau, vite, et ne jamais échouer
// parce qu'un site tiers est en maintenance. La lancer se fait à la main, et se lit :
//
//     npx vitest run src/lib/squashnet/calendar.live.test.ts -t "" --reporter=verbose
//
// en remplaçant `describe.skip` par `describe` le temps de la mesure. Ce qu'on regarde : le
// nombre de rencontres (~4 par journée), les dates, et que les journées non planifiées
// ressortent bien en `dateConfirmed: false`.
//
// L'événement visé est le Critérium IDF Hommes 2025-26, celui qui a servi à écrire le parsing.
// Il finira par disparaître : le remplacer par l'événement de la saison en cours fait partie de
// l'usage de cette sonde.
const EVENT_ESSAI = "879981be57df0005cac674dce4378296";

describe.skip("calendrier squashnet — sonde réseau manuelle", () => {
  it("le format publié est toujours celui que le parsing attend", async () => {
    const ties = await fetchTeamCalendar(EVENT_ESSAI);
    console.log(`rencontres : ${ties.length}`);
    console.log([...new Set(ties.map((t) => `${t.round} = ${t.date} ${t.time}`))].join("\n"));
    console.log(JSON.stringify(ties[0], null, 2));

    // Une équipe quelconque de l'événement, pour éprouver le filtrage et la date bouchon.
    const own = ownFixtures(ties, ties[0]?.homeTeamId ?? "");
    console.log(`non confirmées : ${own.filter((t) => !t.dateConfirmed).map((t) => t.round).join(", ")}`);

    expect(ties.length).toBeGreaterThan(0);
    expect(ties[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ties[0].homeTeamId).toMatch(/^\d+$/);
  }, 30_000);
});
