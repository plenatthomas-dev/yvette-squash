import { describe, it, expect, beforeEach } from "vitest";
import { applyTheme, THEME_COLORS } from "./theme";

beforeEach(() => {
  document.head.innerHTML =
    '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff">' +
    '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0f1115">';
  document.documentElement.removeAttribute("data-theme");
});

const couleurs = () =>
  [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((m) => m.content);

describe("applyTheme — la barre du navigateur suit le thème CHOISI", () => {
  it("thème sombre choisi : les deux balises passent au sombre", () => {
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(couleurs()).toEqual([THEME_COLORS.dark, THEME_COLORS.dark]);
  });

  it("retour à « Système » : chaque balise retrouve la couleur de son media", () => {
    applyTheme("rose");
    applyTheme("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(couleurs()).toEqual([THEME_COLORS.light, THEME_COLORS.dark]);
  });
});
