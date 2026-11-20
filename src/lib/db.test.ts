import { describe, it, expect, vi } from "vitest";

vi.mock("@prisma/client", () => ({ PrismaClient: class {} }));
vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: class {} }));

import { sslmodeExplicite } from "./db";

const base = "postgresql://u:p%40ss@ep-x-pooler.eu-central-1.aws.neon.tech/neondb";

describe("sslmodeExplicite", () => {
  it.each(["require", "prefer", "verify-ca", "REQUIRE"])("%s → verify-full", (mode) => {
    expect(sslmodeExplicite(`${base}?sslmode=${mode}&channel_binding=require`)).toBe(
      `${base}?sslmode=verify-full&channel_binding=require`,
    );
  });

  it("garde le reste de l'URL, paramètre en fin comprise", () => {
    expect(sslmodeExplicite(`${base}?channel_binding=require&sslmode=require`)).toBe(
      `${base}?channel_binding=require&sslmode=verify-full`,
    );
  });

  it("ne touche pas à channel_binding=require", () => {
    expect(sslmodeExplicite(`${base}?channel_binding=require`)).toBe(`${base}?channel_binding=require`);
  });

  it("laisse verify-full, disable, l'absence de mode et le choix libpq", () => {
    for (const u of [
      `${base}?sslmode=verify-full`,
      `${base}?sslmode=disable`,
      base,
      `${base}?uselibpqcompat=true&sslmode=require`,
    ]) {
      expect(sslmodeExplicite(u)).toBe(u);
    }
    expect(sslmodeExplicite(undefined)).toBeUndefined();
  });
});
