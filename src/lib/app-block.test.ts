import { describe, it, expect, vi, beforeEach } from "vitest";

// LA GARDE « APPLI BLOQUÉE » N'AVAIT AUCUN TEST PROPRE : les routes qui l'appellent la
// remplacent par un bouchon (cf. api/auth/email/reset/route.test.ts). Ce fichier la fait tourner
// pour de vrai, avec la vraie lecture du réglage (`settings.getAppBlock`) : seule la base est
// simulée.
//
// L'allowlist admin est simulée elle aussi, pour une raison de périmètre : `admin.ts` tire
// derrière lui la session, les notifications push et l'envoi d'e-mails, dont cette garde ne
// dépend en rien. Ce qu'on vérifie ici, c'est l'ORDRE et la COMPOSITION des contrôles.
const h = vi.hoisted(() => ({
  /** La ligne `AppSetting` de clé « block », telle que Prisma la rend (ou `null`). */
  reglage: null as null | { value: string },
  lectureJette: false,
  /** L'e-mail du membre, tel que `user.findUnique` le rend. */
  email: "membre@club.fr" as string | null,
  appSettingFindUnique: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock("./db", () => ({
  prisma: {
    appSetting: { findUnique: (...a: unknown[]) => h.appSettingFindUnique(...a) },
    user: { findUnique: (...a: unknown[]) => h.userFindUnique(...a) },
  },
}));
vi.mock("./admin", () => ({
  isAdminUser: (u: { email?: string | null } | null | undefined) => u?.email === "admin@club.fr",
}));

import { appBlockForEmail, appBlockForUserId, appBlockedResponse } from "./app-block";
import { BLOCK_DEFAULT_MESSAGE } from "./settings";

const bloque = (message = "Fermé pour travaux") => ({
  value: JSON.stringify({ enabled: true, message }),
});

beforeEach(() => {
  h.reglage = null;
  h.lectureJette = false;
  h.email = "membre@club.fr";
  h.appSettingFindUnique.mockReset().mockImplementation(async () => {
    if (h.lectureJette) throw new Error("base injoignable");
    return h.reglage;
  });
  h.userFindUnique.mockReset().mockImplementation(async () => (h.email ? { email: h.email } : null));
});

describe("appBlockForUserId — routes authentifiées", () => {
  it("blocage actif + simple membre → bloqué, avec le message de l'admin", async () => {
    h.reglage = bloque("Fermé pour travaux");
    expect(await appBlockForUserId("u1")).toEqual({ message: "Fermé pour travaux" });
  });

  it("blocage actif + admin → passe : on ferme l'appli aux membres, pas à soi-même", async () => {
    h.reglage = bloque();
    h.email = "admin@club.fr";
    expect(await appBlockForUserId("u-admin")).toBeNull();
  });

  // Le chemin chaud : chaque requête authentifiée passe ici, et chaque lecture réveille Neon.
  it("appli ouverte → passe, en UNE lecture, sans aller chercher le membre", async () => {
    expect(await appBlockForUserId("u1")).toBeNull();
    expect(h.appSettingFindUnique).toHaveBeenCalledOnce();
    expect(h.userFindUnique).not.toHaveBeenCalled();
  });

  it("un blocage DÉSACTIVÉ (ligne conservée, `enabled: false`) laisse passer", async () => {
    h.reglage = { value: JSON.stringify({ enabled: false, message: "Ancien message" }) };
    expect(await appBlockForUserId("u1")).toBeNull();
  });

  it("un membre introuvable (compte supprimé entre-temps) reste bloqué", async () => {
    h.reglage = bloque();
    h.email = null;
    expect(await appBlockForUserId("u-fantome")).not.toBeNull();
  });

  it("un message vide retombe sur le message par défaut", async () => {
    h.reglage = bloque("   ");
    expect(await appBlockForUserId("u1")).toEqual({ message: BLOCK_DEFAULT_MESSAGE });
  });

  // COMPORTEMENT DOCUMENTÉ dans `settings.getAppBlock` : une lecture en échec laisse l'appli
  // OUVERTE. Le blocage est un confort d'administration, pas une barrière de sécurité : fermer
  // l'appli à tout le monde parce que Neon a toussé serait pire que la laisser ouverte quelques
  // secondes de trop pendant une maintenance.
  it("lecture du réglage en échec → l'appli reste ouverte, et l'échec est journalisé", async () => {
    const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
    h.lectureJette = true;
    expect(await appBlockForUserId("u1")).toBeNull();
    expect(erreur).toHaveBeenCalledOnce();
    erreur.mockRestore();
  });
});

describe("appBlockForEmail — chemins de connexion", () => {
  it("blocage actif + identifiant d'un membre → bloqué", async () => {
    h.reglage = bloque("Maintenance ce soir");
    expect(await appBlockForEmail("membre@club.fr")).toEqual({ message: "Maintenance ce soir" });
  });

  it("identifiant admin → passe", async () => {
    h.reglage = bloque();
    h.email = "admin@club.fr";
    expect(await appBlockForEmail("admin@club.fr")).toBeNull();
  });

  it("appli ouverte → passe en UNE lecture, sans aller chercher le membre", async () => {
    expect(await appBlockForEmail("membre@club.fr")).toBeNull();
    expect(h.userFindUnique).not.toHaveBeenCalled();
  });

  it.each([[null], [undefined], [""]])("identifiant absent (%j) → traité comme un membre", async (email) => {
    h.reglage = bloque();
    expect(await appBlockForEmail(email)).not.toBeNull();
  });

  it("lecture du réglage en échec → l'appli reste ouverte", async () => {
    const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
    h.lectureJette = true;
    expect(await appBlockForEmail("membre@club.fr")).toBeNull();
    erreur.mockRestore();
  });
});

describe("appBlockedResponse", () => {
  // 503 et non 403 : une indisponibilité voulue et temporaire, que le client sait présenter.
  it("503, avec le message et le marqueur `blocked`", async () => {
    const res = appBlockedResponse({ message: "Fermé pour travaux" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Fermé pour travaux", blocked: true });
  });
});
