import type { PlanningDay, Slot, Court } from "./types";

// Données factices pour développer l'UI tant que l'API réelle n'est pas branchée.
// Remplacé par les vraies données dès que client.getPlanning() est implémenté depuis le HAR.

const COURTS: Court[] = [
  { id: "court-1", name: "Court 1" },
  { id: "court-2", name: "Court 2" },
  { id: "court-3", name: "Court 3" },
  { id: "court-4", name: "Court 4" },
];

const OPEN_HOUR = 9;
const CLOSE_HOUR = 23;
const SLOT_MINUTES = 40;

// Pseudo-aléatoire déterministe (même date => même planning), pour une UI stable en dev.
function seeded(n: number): number {
  const x = Math.sin(n) * 10000;
  return x - Math.floor(x);
}

export function mockPlanning(date: string, clubId: string): PlanningDay {
  const slots: Slot[] = [];
  const base = new Date(`${date}T00:00:00`);
  let seed = Number(date.replaceAll("-", ""));

  for (let ci = 0; ci < COURTS.length; ci++) {
    const court = COURTS[ci];
    for (
      let mins = OPEN_HOUR * 60;
      mins < CLOSE_HOUR * 60;
      mins += SLOT_MINUTES
    ) {
      const start = new Date(base.getTime() + mins * 60_000);
      const end = new Date(start.getTime() + SLOT_MINUTES * 60_000);
      const r = seeded(seed++ + ci * 7);
      const status = r < 0.55 ? "booked" : r < 0.95 ? "free" : "closed";
      slots.push({
        id: `${court.id}_${start.toISOString()}`,
        courtId: court.id,
        courtName: court.name,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        status,
        bookable: status === "free",
        remaining: status === "free" ? 1 : 0,
      });
    }
  }

  return { date, clubId, courts: COURTS, slots };
}
