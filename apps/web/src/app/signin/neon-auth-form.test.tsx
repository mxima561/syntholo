import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("NeonAuthForm post-login destination", () => {
  it("tells Neon Auth to return to the academy instead of the marketing root", () => {
    const source = readFileSync("src/app/signin/neon-auth-form.tsx", "utf8");
    expect(source).toContain("callbackURL: MEMBER_HOME_PATH");
    expect(source).toContain("goToMemberHome()");
    expect(source).toContain("resetPasswordUrl()");
    expect(source).not.toContain('router.push("/learn")');
    expect(source).not.toContain("router.refresh()");
    expect(source).not.toContain('redirectTo: `${window.location.origin}/signin`');
  });
});
