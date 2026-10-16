import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isView } from "@/lib/views";
import manifest from "./manifest";

// Les raccourcis de l'icône vivent à DEUX endroits : le manifest web (PWA) et
// android/twa-manifest.json, que Bubblewrap ne relit pas tout seul. Ces tests disent quand
// l'un a bougé sans l'autre, et quand un raccourci vise une vue que l'appli ne connaît pas
// (elle retomberait alors sur le planning sans rien dire).

const racine = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const shortcuts = manifest().shortcuts ?? [];
const twa = JSON.parse(readFileSync(racine("android/twa-manifest.json"), "utf8")) as {
  packageId: string;
  host: string;
  shortcuts: { name: string; url: string; chosenIconUrl: string; chosenMaskableIconUrl?: string }[];
};

describe("raccourcis de l'icône", () => {
  it("ouvrent chacun une vue connue de l'appli", () => {
    expect(shortcuts.length).toBeGreaterThan(0);
    for (const s of shortcuts) {
      expect(isView(new URL(s.url, "https://x").searchParams.get("view"))).toBe(true);
    }
  });

  it("ont leurs icônes dans public/", () => {
    for (const s of shortcuts) {
      for (const i of s.icons ?? []) expect(existsSync(racine(`public${i.src}`))).toBe(true);
    }
  });

  it("sont les mêmes dans l'appli Android, dans le même ordre", () => {
    const base = `https://${twa.host}`;
    expect(twa.shortcuts.map((s) => [s.name, s.url, s.chosenIconUrl, s.chosenMaskableIconUrl])).toEqual(
      shortcuts.map((s) => {
        const icone = `${base}${s.icons?.[0]?.src}`;
        return [s.name, `${base}${s.url}`, icone, icone];
      }),
    );
  });
});

// Sans le bon package, `getInstalledRelatedApps` ne trouve jamais l'appli : la PWA continue de
// la proposer à qui l'a déjà (cf. AndroidAppPrompt).
describe("l'appli Android liée", () => {
  it("est celle que construit Bubblewrap", () => {
    expect(manifest().related_applications).toEqual([
      expect.objectContaining({ platform: "play", id: twa.packageId }),
    ]);
  });

  it("ne détourne pas l'installation de la PWA vers le Play Store", () => {
    expect(manifest().prefer_related_applications).toBeFalsy();
  });
});
