import { describe, expect, it, vi } from "vitest";
import { MEMBER_HOME_PATH, RESET_PASSWORD_PATH, goToMemberHome, memberHomeUrl, resetPasswordUrl } from "./member-destination";

describe("member destination", () => {
  it("keeps post-login navigation on the academy, not the marketing root", () => {
    expect(MEMBER_HOME_PATH).toBe("/learn");
    expect(RESET_PASSWORD_PATH).toBe("/reset-password");
    expect(memberHomeUrl("https://app.syntholo.com")).toBe("https://app.syntholo.com/learn");
    expect(resetPasswordUrl("https://app.syntholo.com")).toBe("https://app.syntholo.com/reset-password");
  });

  it("replaces the current page so the session cookie is visible on the next load", () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { assign });
    goToMemberHome();
    expect(assign).toHaveBeenCalledWith("/learn");
    vi.unstubAllGlobals();
  });
});
