import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import PricingPage from "./page";

describe("PricingPage", () => {
  it("sends existing members to the authentication route", () => {
    render(<PricingPage />);

    expect(screen.getByRole("link", { name: /member sign in/i })).toHaveAttribute(
      "href",
      "/sign-in",
    );
  });
});
