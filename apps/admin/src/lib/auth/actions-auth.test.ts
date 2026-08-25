import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("admin server actions independently authorize", () => {
  it("Case 6: every exported mutation goes through requireStaff", () => {
    const source = readFileSync("src/app/actions.ts", "utf8");
    const exports = [...source.matchAll(/^export async function (\w+)/gm)].map((match) => match[1]);
    expect(exports.length).toBeGreaterThan(5);
    for (const name of exports) {
      const start = source.indexOf(`export async function ${name}`);
      const next = source.indexOf("export async function ", start + 1);
      const body = next === -1 ? source.slice(start) : source.slice(start, next);
      expect(body, name).toMatch(/staffOrForbidden\(|requireStaff\(/);
    }
  });
});
