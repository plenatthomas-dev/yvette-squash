import { describe, it, expect, beforeEach, vi } from "vitest";

// L'E-MAIL PORTÉ PAR LA SESSION — une économie de requête qui n'était garantie par rien.
//
// La branche interclub a ajouté `email` à `AppSession` avec une raison chiffrée : l'adresse est
// DÉJÀ chargée par la lecture de session (`include: { user: true }`) et était jetée. L'exposer
// épargne un `user.findUnique` par requête à tout appelant qui n'avait besoin que de tester
// l'allowlist admin — et sur Neon, une requête évitée sur un chemin chaud compte plus que la
// ligne de code qu'elle coûte. Trois routes interclub s'en servent désormais.
//
// La promesse à tenir est donc double, et aucune des deux ne se voit à l'exécution :
//   * l'e-mail vient de la ligne DÉJÀ LUE — une seconde requête annulerait tout le bénéfice,
//     sans que rien ne change à l'écran ;
//   * il vaut `null` pour un compte ResaMania sans adresse connue, et c'est ce `null` que le
//     fail-safe d'`isAdminEmail` reçoit (cf. `admin.test.ts`).

const h = vi.hoisted(() => ({
  sessionFindUnique: vi.fn(),
  sessionDelete: vi.fn(async () => ({})),
  userFindUnique: vi.fn(),
}));

vi.mock("./db", () => ({
  prisma: {
    session: { findUnique: h.sessionFindUnique, delete: h.sessionDelete },
    user: { findUnique: h.userFindUnique, updateMany: vi.fn(async () => ({ count: 0 })) },
  },
}));
vi.mock("./crypto", () => ({ encrypt: (s: string) => s, decrypt: (s: string) => s }));
vi.mock("./resamania/client", () => ({ ensureFresh: vi.fn() }));

import { getSession, normalizeEmail } from "./session";

/** Une session « email seul » : aucun jeton ResaMania, donc aucun déchiffrement à faire. */
function session(user: { displayName: string; email: string | null }) {
  return {
    id: "sid-1",
    userId: "u1",
    expiresAt: new Date(Date.now() + 86_400_000),
    accessToken: null,
    refreshTokenEnc: null,
    tokenExpiresAt: null,
    identityJson: null,
    user,
  };
}

beforeEach(() => {
  h.sessionFindUnique.mockReset();
  h.sessionDelete.mockClear();
  h.userFindUnique.mockReset();
});

describe("getSession", () => {
  it("rend l'e-mail du membre SANS aller le rechercher", async () => {
    // Le cœur de la décision : une seule lecture. Si une seconde requête apparaissait ici, tout
    // le bénéfice disparaîtrait — et rien, à l'écran, ne le dirait.
    h.sessionFindUnique.mockResolvedValue(
      session({ displayName: "Thomas", email: "thomas@exemple.fr" }),
    );

    const s = await getSession("sid-1");

    expect(s).toMatchObject({ userId: "u1", displayName: "Thomas", email: "thomas@exemple.fr" });
    expect(h.sessionFindUnique).toHaveBeenCalledTimes(1);
    expect(h.userFindUnique).not.toHaveBeenCalled();
  });

  it("rend `null` — et non une chaîne vide — pour un compte sans adresse connue", async () => {
    // Un compte ResaMania peut n'avoir aucune adresse. C'est ce `null` que reçoit
    // `isAdminEmail`, dont le fail-safe rend `false` : le défaut reste fermé.
    h.sessionFindUnique.mockResolvedValue(session({ displayName: "Sans mail", email: null }));

    const s = await getSession("sid-1");

    expect(s!.email).toBeNull();
  });

  it("rend `null` sans rien demander quand il n'y a pas de cookie", async () => {
    expect(await getSession(undefined)).toBeNull();
    expect(h.sessionFindUnique).not.toHaveBeenCalled();
  });

  it("rend `null` quand la session est inconnue", async () => {
    h.sessionFindUnique.mockResolvedValue(null);
    expect(await getSession("sid-inconnu")).toBeNull();
  });

  it("SUPPRIME une session expirée au lieu de la rendre", async () => {
    // Une session périmée qu'on laisserait en base repasserait à chaque requête, et la ligne
    // survivrait à son propriétaire.
    h.sessionFindUnique.mockResolvedValue({
      ...session({ displayName: "Thomas", email: "thomas@exemple.fr" }),
      expiresAt: new Date(Date.now() - 1_000),
    });

    expect(await getSession("sid-1")).toBeNull();
    expect(h.sessionDelete).toHaveBeenCalledWith({ where: { id: "sid-1" } });
  });
});

describe("normalizeEmail — la clé d'identité commune ResaMania / email", () => {
  it("retire les espaces et passe en minuscules", () => {
    expect(normalizeEmail("  Thomas@Exemple.FR ")).toBe("thomas@exemple.fr");
  });
});
