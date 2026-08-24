import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WAITLIST_COPY } from "@/components/waitlist-form";
import HomePage from "./page";

describe("HomePage", () => {
  it("makes the waitlist the front door and keeps scorecard secondary", () => {
    render(<HomePage />);

    expect(screen.getByRole("heading", { name: WAITLIST_COPY.headline })).toBeInTheDocument();
    expect(screen.getByText(WAITLIST_COPY.subhead)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: WAITLIST_COPY.cta })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();

    const scorecard = screen.getByRole("link", { name: /take the scorecard/i });
    expect(scorecard).toHaveAttribute("href", "/scorecard");
    expect(scorecard).toHaveClass("button-secondary");

    expect(screen.getByRole("link", { name: /member sign in/i })).toHaveAttribute("href", "/sign-in");

    const hrefs = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(hrefs).not.toContain("/pricing");
    expect(hrefs.some((href) => href?.startsWith("/checkout") === true)).toBe(false);
    expect(hrefs).not.toContain("/internal/waitlist");
    expect(screen.queryByRole("link", { name: /^pricing$/i })).not.toBeInTheDocument();

    expect(screen.queryByText(/professional-services/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/30-day/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/academy/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/learn to use ai for yourself/i)).not.toBeInTheDocument();
  });
});
