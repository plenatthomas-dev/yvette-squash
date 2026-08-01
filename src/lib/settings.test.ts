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

import {
  setBanner,
  clearBanner,
  getAppBlock,
  getAppBlockSetting,
  clearAppBlock,
  BLOCK_DEFAULT_MESSAGE,
} from "./settings";

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

// Blocage de l'appli : un mauvais « non » ferme le club entier — d'où le fail-open partout.
describe("getAppBlock", () => {
  it("appli ouverte quand aucun réglage n'existe", async () => {
    h.current = null;
    expect(await getAppBlock()).toBeNull();
  });

  it("appli ouverte quand le réglage existe mais est désactivé", async () => {
    h.current = { value: JSON.stringify({ enabled: false, message: "Appli en maintenance" }) };
    expect(await getAppBlock()).toBeNull();
  });

  it("renvoie le message quand le blocage est actif", async () => {
    h.current = { value: JSON.stringify({ enabled: true, message: "Travaux jusqu'à 18 h" }) };
    expect(await getAppBlock()).toEqual({ message: "Travaux jusqu'à 18 h" });
  });

  it("retombe sur le message par défaut si l'admin l'a laissé vide", async () => {
    h.current = { value: JSON.stringify({ enabled: true, message: "   " }) };
    expect(await getAppBlock()).toEqual({ message: BLOCK_DEFAULT_MESSAGE });
  });

  it("FAIL-OPEN : valeur illisible → appli ouverte (ne jamais fermer sur un pépin)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.current = { value: "{ ceci n'est pas du JSON" };
    expect(await getAppBlock()).toBeNull();
  });

  it("FAIL-OPEN : base injoignable → appli ouverte", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.findUnique.mockRejectedValue(new Error("P1001"));
    expect(await getAppBlock()).toBeNull();
  });

  it("n'accepte pas un `enabled` approximatif (chaîne « true ») comme un blocage", async () => {
    h.current = { value: JSON.stringify({ enabled: "true", message: "x" }) };
    expect(await getAppBlock()).toBeNull();
  });
});

describe("getAppBlockSetting / clearAppBlock", () => {
  it("expose le switch ET le message même blocage inactif (pré-remplissage de /admin)", async () => {
    h.current = { value: JSON.stringify({ enabled: false, message: "Travaux" }) };
    expect(await getAppBlockSetting()).toEqual({ enabled: false, message: "Travaux" });
  });

  it("la réouverture CONSERVE le message (réutilisable la fois suivante)", async () => {
    await clearAppBlock("Travaux jusqu'à 18 h", "adm");
    const written = JSON.parse(h.upsert.mock.calls[0][0].update.value);
    expect(written).toEqual({ enabled: false, message: "Travaux jusqu'à 18 h" });
  });
});
