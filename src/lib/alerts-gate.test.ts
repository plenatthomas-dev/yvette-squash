import { describe, it, expect, vi, afterEach } from "vitest";

// `alerts-gate` importe le Data Cache de Next et Prisma ; seules les bornes de date sont
// testées ici, ce sont des fonctions pures. On neutralise donc le reste.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: unknown) => fn,
  revalidateTag: vi.fn(),
}));
vi.mock("./db", () => ({ prisma: { slotAlert: { count: vi.fn() } } }));
vi.mock("./cron-run", () => ({ recordCronRun: vi.fn() }));

import { alertHorizonISO, alertTodayISO, ALERT_MAX_DAYS_AHEAD } from "./alerts-gate";

afterEach(() => vi.useRealTimers());

/** Ajoute n jours de CALENDRIER à une date ISO (référence indépendante de l'implémentation). */
function plusJours(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

describe("bornes de date des alertes", () => {
  it("compte depuis la date du CLUB, pas celle du serveur", () => {
    // Le piège : sur Vercel le process tourne en UTC. Ici il est 00 h 30 le 21 août à Paris,
    // mais encore le 20 en UTC — une borne calculée sur le fuseau ambiant décalerait tout d'un
    // jour et refuserait un créneau que le planning affiche pourtant.
    vi.setSystemTime(new Date("2026-08-20T22:30:00Z"));
    expect(alertTodayISO()).toBe("2026-08-21");
    expect(alertHorizonISO()).toBe(plusJours("2026-08-21", ALERT_MAX_DAYS_AHEAD));
    expect(alertHorizonISO()).not.toBe(plusJours("2026-08-20", ALERT_MAX_DAYS_AHEAD));
  });

  it("ne dérape pas d'un jour au changement d'heure", () => {
    // 00 h 30 le 1er octobre à Paris ; la fenêtre franchit le passage à l'heure d'hiver
    // (25 octobre). Une arithmétique en millisecondes perdrait l'heure gagnée et retomberait
    // à 23 h 30 la VEILLE — soit une date de moins. On compte en jours de calendrier.
    vi.setSystemTime(new Date("2026-09-30T22:30:00Z"));
    const naif = new Date(Date.now() + ALERT_MAX_DAYS_AHEAD * 86_400_000)
      .toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });
    expect(alertHorizonISO()).toBe(plusJours("2026-10-01", ALERT_MAX_DAYS_AHEAD));
    expect(alertHorizonISO()).not.toBe(naif); // le calcul naïf se trompe bien ici
  });

  it("laisse passer aujourd'hui et refuse la veille", () => {
    // La borne basse est inclusive : une alerte posée le matin pour un créneau du soir même
    // est parfaitement légitime.
    vi.setSystemTime(new Date("2026-08-20T09:00:00Z"));
    expect(alertTodayISO()).toBe("2026-08-20");
    expect("2026-08-20" < alertTodayISO()).toBe(false);
    expect("2026-08-19" < alertTodayISO()).toBe(true);
  });
});
