import { describe, it, expect } from "vitest";
import { parseNotifReport, platformBreakdown, summarizeNotifStates } from "./notif-state";

// LA MESURE DOIT COMPTER DES MEMBRES, PAS DES APPAREILS. Un membre qui reçoit sur son téléphone
// n'est pas « bloqué » parce que son ordinateur a refusé ; et un refus doit passer avant un
// « jamais demandé », sinon celui qui a besoin d'aide se perd dans la masse.

const ID = "0b9f3c1e-7a42-4d55-9a0e-2c6f8e1d4b77";

describe("parseNotifReport", () => {
  it("accepte un relevé bien formé", () => {
    expect(
      parseNotifReport({ deviceId: ID, permission: "denied", subscribed: false, platform: "android-app" }),
    ).toEqual({ deviceId: ID, permission: "denied", subscribed: false, platform: "android-app" });
  });

  it("refuse ce qui sortirait des valeurs connues — c'est une clé primaire écrite par le client", () => {
    const ok = { deviceId: ID, permission: "granted", subscribed: true, platform: "ios" };
    expect(parseNotifReport(null)).toBeNull();
    expect(parseNotifReport({ ...ok, deviceId: "court" })).toBeNull();
    expect(parseNotifReport({ ...ok, deviceId: "x".repeat(65) })).toBeNull();
    expect(parseNotifReport({ ...ok, deviceId: "a b c d e f g h i j" })).toBeNull();
    expect(parseNotifReport({ ...ok, permission: "prompt" })).toBeNull();
    expect(parseNotifReport({ ...ok, platform: "windows-phone" })).toBeNull();
    expect(parseNotifReport({ ...ok, subscribed: "true" })).toBeNull();
  });
});

describe("summarizeNotifStates", () => {
  const ligne = (userId: string, permission: string, subscribed: boolean, platform = "desktop") => ({
    userId,
    permission,
    subscribed,
    platform,
  });

  it("classe chaque membre par son MEILLEUR appareil", () => {
    const s = summarizeNotifStates([
      ligne("a", "granted", true, "android-app"),
      ligne("a", "denied", false, "desktop"), // reçoit ailleurs : pas « bloqué »
      ligne("b", "denied", false, "android-app"),
      ligne("b", "default", false, "desktop"), // le refus passe avant « jamais demandé »
      ligne("c", "default", false),
      ligne("d", "granted", false), // « Ne plus recevoir »
      ligne("e", "unsupported", false, "ios"),
    ]);
    expect(s.members).toBe(5);
    expect(s.devices).toBe(7);
    expect(s.byMember).toEqual({ receiving: 1, denied: 1, off: 1, notAsked: 1, unsupported: 1 });
  });

  it("compte les APPAREILS bloqués par plateforme — là où le guide doit être juste", () => {
    const s = summarizeNotifStates([
      ligne("a", "granted", true, "android-app"),
      ligne("a", "denied", false, "desktop"),
      ligne("b", "denied", false, "android-app"),
      ligne("c", "denied", false, "android-app"),
      ligne("d", "unsupported", false, "ios"),
    ]);
    expect(s.deniedByPlatform).toEqual({ desktop: 1, "android-app": 2 });
    expect(s.unsupportedByPlatform).toEqual({ ios: 1 });
  });

  it("rend des zéros, pas un objet vide, quand personne n'est relevé", () => {
    expect(summarizeNotifStates([]).byMember).toEqual({
      receiving: 0,
      denied: 0,
      off: 0,
      notAsked: 0,
      unsupported: 0,
    });
  });
});

describe("platformBreakdown", () => {
  it("met le plus gros d'abord, en libellés lisibles", () => {
    expect(platformBreakdown({ ios: 1, "android-app": 3, desktop: 0 })).toBe("3 appli Android · 1 iPhone");
  });
});
