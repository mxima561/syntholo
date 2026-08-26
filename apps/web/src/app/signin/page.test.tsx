import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("SignInPage reset-token handling", () => {
  it("forwards password-reset tokens to the reset page instead of the academy gate", () => {
    const source = readFileSync("src/app/signin/page.tsx", "utf8");
    expect(source).toContain("RESET_PASSWORD_PATH");
    expect(source).toContain("params.token");
    expect(source.indexOf("RESET_PASSWORD_PATH")).toBeLessThan(source.indexOf('redirect("/learn")'));
  });
});
