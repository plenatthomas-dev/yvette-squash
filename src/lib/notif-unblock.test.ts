import { describe, it, expect } from "vitest";
import { detectNotifPlatform, unblockGuide, type NotifPlatform } from "./notif-unblock";

// LE BON CHEMIN POUR LE BON APPAREIL. Le message d'origine envoyait tout le monde « dans les
// réglages du navigateur » — y compris l'utilisateur de l'appli Android, dont l'autorisation
// se règle dans les réglages d'ANDROID, où il n'y a aucun navigateur à ouvrir.

const UA = {
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  winChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  winEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  winFirefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
};

describe("detectNotifPlatform", () => {
  it("reconnaît l'appli Android (TWA) avant tout le reste", () => {
    expect(detectNotifPlatform(UA.androidChrome, { androidApp: true, standalone: true })).toBe("android-app");
  });

  it("sépare la PWA installée de l'onglet Chrome sur Android", () => {
    expect(detectNotifPlatform(UA.androidChrome, { standalone: true })).toBe("android-pwa");
    expect(detectNotifPlatform(UA.androidChrome)).toBe("android");
  });

  it("voit un iPad derrière son agent « Macintosh » grâce à l'écran tactile", () => {
    expect(detectNotifPlatform(UA.iphone)).toBe("ios");
    expect(detectNotifPlatform(UA.macSafari, { maxTouchPoints: 5 })).toBe("ios");
    expect(detectNotifPlatform(UA.macSafari)).toBe("safari");
  });

  it("ne prend ni Chrome ni Edge pour Safari, malgré le « Safari/ » de leur agent", () => {
    expect(detectNotifPlatform(UA.winChrome)).toBe("desktop");
    expect(detectNotifPlatform(UA.winEdge)).toBe("desktop");
    expect(detectNotifPlatform(UA.winFirefox)).toBe("firefox");
  });
});

describe("unblockGuide", () => {
  const toutes: NotifPlatform[] = ["android-app", "android-pwa", "android", "ios", "firefox", "safari", "desktop"];

  it("donne trois gestes, partout", () => {
    for (const p of toutes) expect(unblockGuide(p, "squash.test").steps).toHaveLength(3);
  });

  it("envoie l'appli Android dans SES réglages, pas dans ceux d'un navigateur", () => {
    const g = unblockGuide("android-app", "squash.test");
    expect(g.steps.join(" ")).toMatch(/Infos sur l'appli/);
    expect(g.steps.join(" ")).not.toMatch(/navigateur|adresse/i);
  });

  it("dans un onglet Chrome, rappelle que l'appli installée décide — et qu'il faut la LANCER", () => {
    // Pixel 8a, 14/10/2026 : notifications rétablies dans les réglages de l'appli, toujours
    // « bloquées » dans l'onglet, parce que Chrome ne relit ce réglage qu'au lancement.
    const g = unblockGuide("android", "squash.test");
    expect(g.hints?.[0]).toMatch(/appli Squash Yvette.*ouvre l'appli depuis son icône/);
  });

  it("nomme le site là où il faut le retrouver dans une liste", () => {
    expect(unblockGuide("safari", "squash.test").steps.join(" ")).toContain("squash.test");
  });
});
