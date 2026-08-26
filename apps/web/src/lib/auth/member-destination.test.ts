import { describe, expect, it, vi } from "vitest";
import { MEMBER_HOME_PATH, goToMemberHome, memberHomeUrl } from "./member-destination";

describe("member destination", () => {
  it("keeps post-login navigation on the academy, not the marketing root", () => {
    expect(MEMBER_HOME_PATH).toBe("/learn");
    expect(memberHomeUrl("https://app.syntholo.com")).toBe("https://app.syntholo.com/learn");
  });

  it("replaces the current page so the session cookie is visible on the next load", () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { assign });
    goToMemberHome();
    expect(assign).toHaveBeenCalledWith("/learn");
    vi.unstubAllGlobals();
  });
});
