import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTeamCalendar, ownFixtures, parseFrenchDate } from "./calendar";

// ============================================================================
//  LE RENDU DU 2026-10-05 : LA DATE PASSE DE LA JOURNÉE À LA RENCONTRE.
//
//  Jusque-là l'en-tête portait la date de toute la journée (« J1 - mardi 08
//  juin 2027 »). Squashnet l'a réduit à « J1 » et a posé la date sur CHAQUE
//  rencontre, dans un `<p class="draw">`. Le parseur ne datait plus aucune
//  journée, lisait zéro rencontre, et le contrôle hebdomadaire l'a signalé :
//  « Calendrier fédéral illisible » pour nos deux équipes.
//
//  Effet de bord heureux : une journée peut désormais porter DEUX dates. Les
//  rencontres réelles ont leur vraie date, et seule l'exemption reste au
//  bouchon du 08/06/2027 — que la détection par signature isole toujours.
//
//  Fixture RÉELLE, enregistrée le 2026-10-05 :
//    POST index.php  ic_a=393986  eventid=bd775f1a…  roundid=383987
// ============================================================================

const FRAGMENT = readFileSync(
  join(__dirname, "__fixtures__", "calendrier-2027-d4-poule-b-date-par-rencontre.html"),
  "utf8",
);
const YVETTE_1 = "176167";
const YVETTE_2 = "176168";

describe("calendrier à date par rencontre — Hommes 4 poule B, 2026-27", () => {
  const ties = parseTeamCalendar(FRAGMENT);

  it("lit toute la poule : 23 journées, 110 rencontres", () => {
    expect(ties).toHaveLength(110);
    expect(new Set(ties.map((t) => t.round)).size).toBe(23);
  });

  it("date chaque rencontre par SA date, pas par celle de la journée", () => {
    const j1 = ties.filter((t) => t.round === "J1");
    expect(j1.filter((t) => t.date === "2026-10-08")).toHaveLength(4);
    // L'exemption de la journée reste au bouchon.
    expect(j1.filter((t) => t.date === "2027-06-08").map((t) => t.awayTeamName)).toEqual(["EXEMPT"]);
  });

  it("retient vingt rencontres par équipe, et ne déclare prévisionnelles que les exemptions", () => {
    for (const id of [YVETTE_1, YVETTE_2]) {
      const own = ownFixtures(ties, id);
      expect(own).toHaveLength(20);
      const bouchons = own.filter((t) => !t.dateConfirmed);
      expect(bouchons.map((t) => t.opponent)).toEqual(["EXEMPT", "EXEMPT"]);
      expect(own.filter((t) => t.dateConfirmed).every((t) => t.date !== "2027-06-08")).toBe(true);
    }
  });

  it("garde l'heure, le lieu et l'adresse de la rencontre", () => {
    const own = ownFixtures(ties, YVETTE_2).find((t) => t.round === "J1")!;
    expect(own).toMatchObject({
      date: "2026-10-08",
      time: "20:00",
      home: false,
      opponent: "Verrieres 4",
      venue: "SQUASH CLUB DE VERRIERES LE BUISSON",
    });
  });
});

describe("rencontre sans date, sous un en-tête sans date", () => {
  it("est écartée plutôt que datée au hasard — ni celle de la rencontre suivante", () => {
    const html = `
      <div class="b-day"><h2>J1</h2>
        <div class="schedule"><div class="row"><div class="time"><span>20:00</span></div>
          <div class="match"><div class="players">
            <p class="mb-0"><a data-teamid="1">A</a></p><p class="mb-0"><a data-teamid="2">B</a></p>
          </div></div>
          <div class="match"><p class="draw mb-0">jeudi 08 octobre 2026</p><div class="players">
            <p class="mb-0"><a data-teamid="3">C</a></p><p class="mb-0"><a data-teamid="4">D</a></p>
          </div></div>
        </div></div>
      </div>`;
    const ties = parseTeamCalendar(html);
    expect(ties.map((t) => [t.homeTeamId, t.date])).toEqual([["3", "2026-10-08"]]);
  });
});

describe("parseFrenchDate", () => {
  it("lit la forme publiée, « 1er » compris", () => {
    expect(parseFrenchDate("jeudi 08 octobre 2026")).toBe("2026-10-08");
    expect(parseFrenchDate("jeudi 1er avril 2027")).toBe("2027-04-01");
    expect(parseFrenchDate("Hommes 4")).toBeNull();
    expect(parseFrenchDate("")).toBeNull();
  });
});
