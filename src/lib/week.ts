// Calcul des 7 dates d'une semaine ISO (lundi → dimanche) à partir d'une date d'ancrage
// "YYYY-MM-DD". Arithmétique en UTC pur (aucun new Date() local) → résultat identique
// quel que soit le fuseau du serveur. Partagé par le client et l'endpoint /api/week.

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Lundi de la semaine contenant `date` (chaîne "YYYY-MM-DD"). */
export function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const off = (d.getUTCDay() + 6) % 7; // 0 = lundi
  d.setUTCDate(d.getUTCDate() - off);
  return toISODate(d);
}

/** Les 7 dates (lundi → dimanche) de la semaine contenant `date`. */
export function weekDates(date: string): string[] {
  const mon = new Date(`${mondayOf(date)}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(mon);
    d.setUTCDate(d.getUTCDate() + i);
    return toISODate(d);
  });
}
