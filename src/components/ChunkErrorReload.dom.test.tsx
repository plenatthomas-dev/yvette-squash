import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import ChunkErrorReload from "./ChunkErrorReload";

// UN MORCEAU DE JS INTROUVABLE (onglet resté ouvert depuis avant un déploiement) RECHARGE LA PAGE,
// quelle que soit la formulation du bundler : webpack hier, Turbopack depuis Next 16.

let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sessionStorage.clear();
  reload = vi.fn();
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, reload } });
});
afterEach(() => vi.restoreAllMocks());

function rejette(reason: unknown) {
  const ev = new Event("unhandledrejection") as PromiseRejectionEvent;
  Object.defineProperty(ev, "reason", { value: reason });
  window.dispatchEvent(ev);
}

describe("ChunkErrorReload", () => {
  it("recharge sur l'erreur de Turbopack (« Failed to load chunk … »)", () => {
    render(<ChunkErrorReload />);
    rejette(new Error("Failed to load chunk /_next/static/chunks/abc.js from module 123"));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("recharge sur l'erreur de webpack (« Loading chunk 42 failed »)", () => {
    render(<ChunkErrorReload />);
    rejette(new Error("Loading chunk 42 failed."));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("ignore une erreur sans rapport", () => {
    render(<ChunkErrorReload />);
    rejette(new Error("Network request failed"));
    expect(reload).not.toHaveBeenCalled();
  });
});
