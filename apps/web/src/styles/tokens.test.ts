// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

describe("visual refresh tokens", () => {
  it("locks the approved Trusted Growth palette and readable type floor", () => {
    expect(css).toContain("--canvas: #f8f8f6");
    expect(css).toContain("--teal: #0f6f70");
    expect(css).toContain("--coral: #ef7d62");
    expect(css).toContain("--gold: #d5a943");
    expect(css).toContain("--text-body: 1rem");
    expect(css).toContain("--text-ui: 0.875rem");
    expect(css).toContain("--text-meta: 0.75rem");
  });
});
