import { describe, expect, it } from "vitest";
import { ApplicationTransitionError, transitionApplication } from "./review";

describe("transitionApplication", () => {
  it("does not skip review", () => {
    expect(() => transitionApplication("submitted", "checkout_sent")).toThrow(ApplicationTransitionError);
    expect(() => transitionApplication("submitted", "checkout_sent")).toThrow("INVALID_APPLICATION_TRANSITION");
  });

  it("allows staff to approve then send checkout", () => {
    expect(transitionApplication("submitted", "approved")).toBe("approved");
    expect(transitionApplication("approved", "checkout_sent")).toBe("checkout_sent");
  });
});
