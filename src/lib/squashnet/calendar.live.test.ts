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
// en remplaçant `describe.skip` par `describe` le temps de la mesure.
//
// L'événement visé est le Critérium IDF Hommes 2026-27, Hommes 4, poule B — CELUI DE NOS
// ÉQUIPES, et c'est important : une sonde branchée sur la poule de quelqu'un d'autre resterait
// verte le jour où notre ancrage est faux. Il finira par disparaître ; le remplacer par
// l'épreuve de la saison en cours fait partie de l'usage de cette sonde.
const EVENT_ESSAI = "bd775f1a60dbeda0d8f73323538d8404";
/** La POULE de nos équipes dans cette épreuve (Hommes 4 - poule B). SANS ELLE, ON REÇOIT
 *  une autre poule, où l'Yvette ne figure pas — et la sonde mesurerait le calendrier de
 *  quelqu'un d'autre en le croyant vert. */
const POULE_ESSAI = "383987";

/**
 * NOS DEUX ÉQUIPES SONT DANS LA MÊME POULE cette saison, et la sonde les mesure toutes les deux.
 *
 * Ce n'est pas un détail de confort : l'ancrage se règle par équipe, et une sonde qui n'en
 * vérifierait qu'une resterait verte le jour où l'autre pointe la mauvaise poule. Elles se
 * rencontrent d'ailleurs deux fois (J7 et J18), ce qui fait de « Squash de l'Yvette 1 » un
 * adversaire ordinaire du calendrier de l'équipe 2, et réciproquement.
 */
const EQUIPES_ESSAI = [
  { nom: "Yvette 1", snTeamId: "176167" },
  { nom: "Yvette 2", snTeamId: "176168" },
];

// Dernière mesure, le 2026-09-23 : ONZE équipes en aller-retour, soit 23 journées et 110
// rencontres dans la poule, 20 pour chacune des nôtres, aucune date prévisionnelle. Le format
// a changé d'échelle depuis 2025-26 (six équipes, cinq journées, quinze rencontres) : c'est
// pourquoi les bornes ci-dessous ne figent aucun chiffre, seulement l'ordre de grandeur.
describe.skip("calendrier squashnet — sonde réseau manuelle", () => {
  it("le format publié est toujours celui que le parsing attend", async () => {
    const ties = await fetchTeamCalendar(EVENT_ESSAI, POULE_ESSAI);
    console.log(`rencontres : ${ties.length}`);
    console.log([...new Set(ties.map((t) => `${t.round} = ${t.date} ${t.time}`))].join("\n"));
    console.log(JSON.stringify(ties[0], null, 2));

    for (const { nom, snTeamId } of EQUIPES_ESSAI) {
      // NOS équipes, et pas une équipe quelconque : c'est le chemin réel de l'import, filtrage
      // compris. Zéro ici voudrait dire que l'ancrage désigne une poule où l'on ne joue pas.
      const own = ownFixtures(ties, snTeamId);
      console.log(`\n${nom} — nos rencontres : ${own.length}`);
      console.log(own.map((t) => `${t.round} ${t.date} ${t.home ? "dom." : "ext."} ${t.opponent}`).join(" | "));
      console.log(`non confirmées : ${own.filter((t) => !t.dateConfirmed).map((t) => t.round).join(", ")}`);
      expect(own.length).toBeGreaterThan(0);
    }

    expect(ties.length).toBeGreaterThan(0);
    expect(ties[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ties[0].homeTeamId).toMatch(/^\d+$/);
  }, 30_000);
});
