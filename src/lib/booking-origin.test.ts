import { describe, it, expect } from "vitest";
import { bookingOriginHint } from "./booking-origin";

describe("bookingOriginHint", () => {
  it("détection coupée ⇒ dit qu'on ne sait pas, jamais « 100 % via l'appli »", () => {
    // Le piège que l'indicateur doit éviter : sans le flag, bookingsResa vaut 0 par
    // construction — lire « 100 % via l'appli » serait un contresens.
    expect(bookingOriginHint({ bookingsApp: 12, bookingsResa: 0, externalDetection: false })).toBe(
      "origine non détectée",
    );
  });

  it("détection active mais aucune résa ⇒ ne calcule pas de pourcentage (pas de NaN)", () => {
    expect(bookingOriginHint({ bookingsApp: 0, bookingsResa: 0, externalDetection: true })).toBe(
      "aucune résa",
    );
  });

  it("détection active et 0 hors appli ⇒ 100 %, ce qui est cette fois une vraie information", () => {
    expect(bookingOriginHint({ bookingsApp: 8, bookingsResa: 0, externalDetection: true })).toBe(
      "100 % via l'appli · 0 hors appli",
    );
  });

  it("mélange des deux origines ⇒ part de l'appli arrondie + volume hors appli", () => {
    expect(bookingOriginHint({ bookingsApp: 3, bookingsResa: 1, externalDetection: true })).toBe(
      "75 % via l'appli · 1 hors appli",
    );
    // 2/3 = 66,67 % → arrondi à l'entier le plus proche.
    expect(bookingOriginHint({ bookingsApp: 2, bookingsResa: 1, externalDetection: true })).toBe(
      "67 % via l'appli · 1 hors appli",
    );
  });

  it("aucune résa via l'appli ⇒ 0 %", () => {
    expect(bookingOriginHint({ bookingsApp: 0, bookingsResa: 5, externalDetection: true })).toBe(
      "0 % via l'appli · 5 hors appli",
    );
  });
});
