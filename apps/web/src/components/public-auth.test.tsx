import { describe, expect, it } from "vitest";
import { PublicSignIn, PublicSignUp } from "./public-auth";

describe("public auth routing", () => {
  it("keeps sign-up navigation on the local embedded route", () => {
    const signIn = PublicSignIn();

    expect(signIn.props).toMatchObject({
      path: "/sign-in",
      routing: "path",
      signUpUrl: "/sign-up",
      fallbackRedirectUrl: "/learn",
    });
  });

  it("keeps sign-in navigation on the local embedded route", () => {
    const signUp = PublicSignUp();

    expect(signUp.props).toMatchObject({
      path: "/sign-up",
      routing: "path",
      signInUrl: "/sign-in",
      fallbackRedirectUrl: "/learn",
    });
  });
});
