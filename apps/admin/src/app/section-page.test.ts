import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  }),
);

vi.mock("next/navigation", () => ({ notFound }));

describe("admin [section] page", () => {
  it("is a 404 instead of hardcoded metrics", async () => {
    const source = readFileSync("src/app/[section]/page.tsx", "utf8");
    expect(source).toContain("notFound()");
    expect(source).not.toMatch(/Northstar|maria@northstar|conversion rate|fake metrics/i);

    const { default: AdminSectionPage } = await import("./[section]/page");
    expect(() => AdminSectionPage()).toThrow(/404/);
    expect(notFound).toHaveBeenCalledOnce();
  });
});
