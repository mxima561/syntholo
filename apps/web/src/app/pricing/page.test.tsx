import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import PricingPage from "./page";

describe("PricingPage", () => {
  it("lists prices but points buy CTAs at the waitlist", () => {
    render(<PricingPage />);

    expect(screen.getByText("$399")).toBeInTheDocument();
    expect(screen.getByText("$59")).toBeInTheDocument();
    expect(screen.getByText("$999")).toBeInTheDocument();
    expect(screen.getByText("$199/mo")).toBeInTheDocument();

    const hrefs = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(hrefs.some((href) => href?.startsWith("/checkout") === true)).toBe(false);
    expect(screen.getByRole("link", { name: /choose self-paced academy/i })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: /choose operator club/i })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: /review the package/i })).toHaveAttribute("href", "/");
  });
});
