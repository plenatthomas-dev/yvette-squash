import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ recordError: vi.fn(async () => true) }));
vi.mock("@/lib/error-report", () => ({ recordError: h.recordError }));

import { POST } from "./route";

const req = (body: string) =>
  ({ text: async () => body, headers: { get: () => "UA" } }) as unknown as NextRequest;

beforeEach(() => h.recordError.mockClear());

describe("POST /api/client-error", () => {
  it("consigne le message reçu, et rend 204", async () => {
    const res = await POST(req(JSON.stringify({ message: "boum", digest: "d1", path: "/" })));
    expect(res.status).toBe(204);
    expect(h.recordError).toHaveBeenCalledWith(
      expect.objectContaining({ source: "client", message: "boum", digest: "d1", userAgent: "UA" }),
    );
  });

  it("ignore un corps illisible ou trop gros, sans erreur", async () => {
    expect((await POST(req("pas du json"))).status).toBe(204);
    expect((await POST(req("x".repeat(5000)))).status).toBe(204);
    expect(h.recordError).not.toHaveBeenCalled();
  });
});
