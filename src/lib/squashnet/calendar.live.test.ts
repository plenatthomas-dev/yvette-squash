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
// nombre de rencontres (TROIS par journée dans notre poule — six équipes, donc trois
// rencontres ; la fixture figée en compte quinze pour cinq journées), les dates, et que les
// journées non planifiées ressortent bien en `dateConfirmed: false`.
//
// L'événement visé est le Critérium IDF Hommes 2025-26, Hommes 4, poule IVD — CELUI DE NOTRE
// ÉQUIPE, et c'est important : une sonde branchée sur la poule de quelqu'un d'autre resterait
// verte le jour où notre ancrage est faux. Il finira par disparaître ; le remplacer par
// l'épreuve de la saison en cours fait partie de l'usage de cette sonde.
//
// Dernière mesure, le 2026-09-04 : 15 rencontres dans la poule, 5 pour nous, aucune date
// prévisionnelle.
const EVENT_ESSAI = "879981be57df0005cac674dce4378296";
/** La POULE de notre équipe dans cette épreuve (Hommes 4 - Poule IVD). SANS ELLE, ON REÇOIT
 *  une autre poule, où l'Yvette ne figure pas — et la sonde mesurerait le calendrier de
 *  quelqu'un d'autre en le croyant vert. */
const POULE_ESSAI = "370138";
/** Notre `data-teamid` dans cette poule. */
const EQUIPE_ESSAI = "161092";

describe.skip("calendrier squashnet — sonde réseau manuelle", () => {
  it("le format publié est toujours celui que le parsing attend", async () => {
    const ties = await fetchTeamCalendar(EVENT_ESSAI, POULE_ESSAI);
    console.log(`rencontres : ${ties.length}`);
    console.log([...new Set(ties.map((t) => `${t.round} = ${t.date} ${t.time}`))].join("\n"));
    console.log(JSON.stringify(ties[0], null, 2));

    // NOTRE équipe, et pas une équipe quelconque : c'est le chemin réel de l'import, filtrage
    // compris. Zéro ici voudrait dire que l'ancrage désigne une poule où l'on ne joue pas.
    const own = ownFixtures(ties, EQUIPE_ESSAI);
    console.log(`nos rencontres : ${own.length}`);
    console.log(own.map((t) => `${t.round} ${t.date} ${t.home ? "dom." : "ext."} ${t.opponent}`).join(" | "));
    console.log(`non confirmées : ${own.filter((t) => !t.dateConfirmed).map((t) => t.round).join(", ")}`);
    expect(own.length).toBeGreaterThan(0);

    expect(ties.length).toBeGreaterThan(0);
    expect(ties[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ties[0].homeTeamId).toMatch(/^\d+$/);
  }, 30_000);
});
