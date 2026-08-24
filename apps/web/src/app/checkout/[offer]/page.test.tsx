import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import CheckoutPage from "./page";

describe("CheckoutPage", () => {
  it.each(["self-paced", "operator-club", "business-os"] as const)(
    "sends the closed %s checkout back to program options on /",
    async (offer) => {
      render(await CheckoutPage({ params: Promise.resolve({ offer }) }));

      expect(screen.getByRole("link", { name: /back to program options/i })).toHaveAttribute("href", "/");
    },
  );
});
