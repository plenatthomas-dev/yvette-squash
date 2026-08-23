import { describe, it, expect } from "vitest";
import { hasPendingInput, isSafeToReload, type FieldState } from "./update-reload";

const field = (p: Partial<FieldState> = {}): FieldState => ({
  type: "text",
  value: "",
  visible: true,
  ...p,
});

describe("hasPendingInput", () => {
  it("compte un champ visible contenant du texte", () => {
    expect(hasPendingInput(field({ value: "des balles" }))).toBe(true);
  });

  it("compte un mot de passe tapé sur l'écran de connexion", () => {
    expect(hasPendingInput(field({ type: "password", value: "secret" }))).toBe(true);
  });

  it("ignore un champ vide, ou ne contenant que des espaces", () => {
    expect(hasPendingInput(field({ value: "" }))).toBe(false);
    expect(hasPendingInput(field({ value: "   " }))).toBe(false);
  });

  // Régression : le planning porte en permanence un sélecteur de date natif MASQUÉ et toujours
  // rempli (`.datepick-hidden`, ouvert via showPicker()). Le compter comme une saisie rendait
  // le rechargement automatique impossible dès qu'on était connecté — le cas même que la
  // fonctionnalité vise.
  it("ignore un champ rempli mais masqué (sélecteur de date du planning)", () => {
    expect(hasPendingInput(field({ type: "date", value: "2026-08-24", visible: false }))).toBe(
      false,
    );
  });

  it("ignore cases à cocher et boutons radio, même cochés", () => {
    expect(hasPendingInput(field({ type: "checkbox", value: "on" }))).toBe(false);
    expect(hasPendingInput(field({ type: "radio", value: "on" }))).toBe(false);
  });
});

describe("isSafeToReload", () => {
  it("autorise le rechargement quand rien n'est saisi", () => {
    expect(isSafeToReload(false, [field(), field({ type: "checkbox", value: "on" })])).toBe(true);
  });

  it("autorise le rechargement sur un planning connecté (date masquée seule)", () => {
    const planning = [field({ type: "date", value: "2026-08-24", visible: false })];
    expect(isSafeToReload(false, planning)).toBe(true);
  });

  it("refuse tant qu'une modale est ouverte, même sans rien de saisi", () => {
    expect(isSafeToReload(true, [])).toBe(false);
  });

  it("refuse dès qu'un seul champ visible porte une saisie", () => {
    const fields = [field(), field({ value: "repas" }), field()];
    expect(isSafeToReload(false, fields)).toBe(false);
  });

  it("autorise quand la saisie a été effacée (l'utilisateur a fini)", () => {
    expect(isSafeToReload(false, [field({ value: "" })])).toBe(true);
  });
});
