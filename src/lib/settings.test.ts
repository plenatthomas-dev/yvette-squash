import { describe, it, expect, beforeEach, vi } from "vitest";

// La `version` d'une annonce est son `updatedAt` : la bouger invalide les masquages de TOUS les
// membres et leur remet la modale devant les yeux. Réenregistrer un texte identique ne doit donc
// RIEN écrire — sinon un double-clic sur « Enregistrer » rejoue l'annonce pour le club entier.

const h = vi.hoisted(() => ({
  current: null as null | { value: string },
  findUnique: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
}));

vi.mock("./db", () => ({
  prisma: {
    appSetting: { findUnique: h.findUnique, upsert: h.upsert, deleteMany: h.deleteMany },
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

import { setBanner, clearBanner } from "./settings";

const stored = (message: string, level = "info") => ({ value: JSON.stringify({ message, level }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.findUnique.mockImplementation(async () => h.current);
  h.current = null;
});

describe("setBanner", () => {
  it("écrit quand il n'y a pas encore d'annonce", async () => {
    await setBanner("Assemblée vendredi", "info", "adm");
    expect(h.upsert).toHaveBeenCalledTimes(1);
  });

  it("réenregistrer le MÊME message n'écrit rien (pas de re-notification)", async () => {
    h.current = stored("Assemblée vendredi");
    await setBanner("Assemblée vendredi", "info", "adm");
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("ignore les espaces autour : « Texte » et « Texte  » sont la même annonce", async () => {
    h.current = stored("Assemblée vendredi");
    await setBanner("  Assemblée vendredi  ", "info", "adm");
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("un texte MODIFIÉ repasse bien devant tout le monde", async () => {
    h.current = stored("Assemblée vendredi");
    await setBanner("Assemblée samedi", "info", "adm");
    expect(h.upsert).toHaveBeenCalledTimes(1);
  });

  it("changer la seule COULEUR compte aussi comme un changement", async () => {
    h.current = stored("Assemblée vendredi", "info");
    await setBanner("Assemblée vendredi", "warn", "adm");
    expect(h.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("clearBanner", () => {
  it("supprime la ligne", async () => {
    await clearBanner();
    expect(h.deleteMany).toHaveBeenCalledTimes(1);
  });
});
