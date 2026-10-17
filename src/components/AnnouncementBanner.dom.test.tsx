import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import AnnouncementBanner from "./AnnouncementBanner";

// LE BANDEAU « IMPORTANT » DOIT ÊTRE LE PLUS LISIBLE, PAS LE MOINS.
//
// L'orange #ea580c ne tenait que 3,56:1 sous le texte blanc du bandeau (0,95rem demi-gras, donc
// seuil 4,5:1). #c2410c tient 5,18:1. Et la croix porte la classe qui étend sa zone d'appui à
// 44×44 (pseudo-élément, cf. globals.css) — jsdom n'applique pas la feuille, on vérifie donc le
// branchement, la règle elle-même étant testée là où elle est écrite (globals.css.test.ts).

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ banner: { message: "Tournoi samedi", level: "warn", version: "v1" }, authenticated: false }),
    })),
  );
});
afterEach(() => vi.unstubAllGlobals());

it("peint l'annonce importante en #c2410c (5,18:1 sous le blanc), plus en #ea580c", async () => {
  render(<AnnouncementBanner />);
  const bandeau = (await screen.findByText("Tournoi samedi")).closest('[role="status"]') as HTMLElement;
  expect(bandeau.style.background).toBe("rgb(194, 65, 12)");
  expect(bandeau.style.color).toBe("rgb(255, 255, 255)");
});

it("la croix porte la zone d'appui élargie, sans changer sa boîte", async () => {
  render(<AnnouncementBanner />);
  const croix = await screen.findByRole("button", { name: "Masquer l'annonce" });
  expect(croix.classList.contains("announce-close")).toBe(true);
  expect(croix.style.padding).toBe("0px");
});
