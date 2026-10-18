import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ count: vi.fn(), create: vi.fn() }));
vi.mock("./db", () => ({ prisma: { errorReport: { count: h.count, create: h.create } } }));

import { recordError } from "./error-report";

beforeEach(() => {
  h.count.mockReset().mockResolvedValue(0);
  h.create.mockReset().mockResolvedValue({});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("recordError", () => {
  it("écrit une ligne, message tronqué à 500 caractères", async () => {
    expect(await recordError({ source: "client", message: "x".repeat(900), path: "/" })).toBe(true);
    expect(h.create.mock.calls[0][0].data.message).toHaveLength(500);
  });

  it("au-delà du plafond horaire, n'écrit plus rien", async () => {
    h.count.mockResolvedValue(60);
    expect(await recordError({ source: "server", message: "m" })).toBe(false);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("base en panne → false, jamais d'exception", async () => {
    h.count.mockRejectedValue(new Error("base"));
    await expect(recordError({ source: "server", message: "m" })).resolves.toBe(false);
  });
});
