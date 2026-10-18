// Thème choisi par le membre (Réglages), appliqué au document ET à la barre du navigateur.
//
// La couleur de la barre (`<meta name="theme-color">`) suivait seulement le thème du SYSTÈME
// (deux balises à `media`, posées par le layout) : un membre en thème sombre sur un téléphone
// clair gardait une barre blanche au-dessus d'une page noire (audit 2026-10, point 29). Les
// deux balises prennent donc la couleur du thème choisi, et retrouvent la leur en « Système ».
//
// ⚠️ Les mêmes valeurs vivent dans le script inline du layout (`themeScript`), qui les applique
// avant le premier rendu : à changer ensemble.

export type Theme = "system" | "light" | "dark" | "rose";

export const THEME_COLORS: Record<Exclude<Theme, "system">, string> = {
  light: "#ffffff",
  dark: "#0f1115",
  rose: "#ffc9e3",
};

export function isTheme(v: unknown): v is Theme {
  return v === "system" || v === "light" || v === "dark" || v === "rose";
}

export function applyTheme(t: Theme): void {
  const el = document.documentElement;
  if (t === "system") el.removeAttribute("data-theme"); // Pico suit prefers-color-scheme
  else el.setAttribute("data-theme", t);
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const systeme = /dark/.test(meta.getAttribute("media") ?? "") ? THEME_COLORS.dark : THEME_COLORS.light;
    meta.setAttribute("content", t === "system" ? systeme : THEME_COLORS[t]);
  }
}
