import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("./db", () => ({
  prisma: { appSetting: { findUnique: h.findUnique, upsert: h.upsert } },
}));

import { getFeatureOverrides, invalidateFeatureCache, setFeatureOverride } from "./features-server";

const row = (value: unknown) => ({ value: JSON.stringify(value), updatedAt: new Date() });

beforeEach(() => {
  invalidateFeatureCache();
  h.findUnique.mockReset();
  h.upsert.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getFeatureOverrides", () => {
  it("lit les overrides posés en base", async () => {
    h.findUnique.mockResolvedValue(row({ tricount: true, ranking: false }));
    expect(await getFeatureOverrides()).toEqual({ tricount: true, ranking: false });
  });

  it("aucune ligne en base → aucun override (tout en « auto »)", async () => {
    h.findUnique.mockResolvedValue(null);
    expect(await getFeatureOverrides()).toEqual({});
  });

  it("base indisponible → repli sur l'env, sans jeter", async () => {
    // Le point important : une panne Neon ne doit pas rendre les flags indéterminés ni
    // faire tomber toutes les routes API — on retombe sur le défaut sûr de l'environnement.
    h.findUnique.mockRejectedValue(new Error("connexion Neon perdue"));
    expect(await getFeatureOverrides()).toEqual({});
  });

  it("JSON corrompu en base → repli, sans jeter", async () => {
    h.findUnique.mockResolvedValue({ value: "{pas du json", updatedAt: new Date() });
    expect(await getFeatureOverrides()).toEqual({});
  });

  it("met en cache : deux lectures rapprochées ne touchent la base qu'une fois", async () => {
    h.findUnique.mockResolvedValue(row({ tricount: true }));
    await getFeatureOverrides();
    await getFeatureOverrides();
    expect(h.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe("setFeatureOverride", () => {
  it("pose un override et le rend visible immédiatement (cache rafraîchi)", async () => {
    h.findUnique.mockResolvedValue(null);
    h.upsert.mockResolvedValue({});

    expect(await setFeatureOverride("tricount", true, "adm")).toEqual({ tricount: true });
    // Pas de relecture en base : l'écriture a réamorcé le cache.
    h.findUnique.mockRejectedValue(new Error("ne devrait pas être appelé"));
    expect(await getFeatureOverrides()).toEqual({ tricount: true });
  });

  it("`null` retire l'override (retour à « auto ») sans toucher aux autres", async () => {
    h.findUnique.mockResolvedValue(row({ tricount: true, ranking: false }));
    h.upsert.mockResolvedValue({});

    expect(await setFeatureOverride("tricount", null, "adm")).toEqual({ ranking: false });
    // C'est bien l'objet complet qui est réécrit, pas seulement la clé touchée.
    expect(JSON.parse(h.upsert.mock.calls[0][0].update.value)).toEqual({ ranking: false });
  });

  it("forcer à `false` est persisté (et non confondu avec un retrait)", async () => {
    h.findUnique.mockResolvedValue(null);
    h.upsert.mockResolvedValue({});
    expect(await setFeatureOverride("emailLogin", false, "adm")).toEqual({ emailLogin: false });
  });
});
