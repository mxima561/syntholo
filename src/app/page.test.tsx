import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HomePage from "./page";

describe("HomePage", () => {
  it("gives business owners a clear path into the academy", () => {
    render(<HomePage />);

    expect(
      screen.getByRole("heading", { name: /put ai to work across your business/i }),
    ).toBeInTheDocument();
    const scorecardLinks = screen.getAllByRole("link", { name: /take the free scorecard/i });
    expect(scorecardLinks.length).toBeGreaterThan(0);
    for (const link of scorecardLinks) {
      expect(link).toHaveAttribute("href", "/scorecard");
    }
    expect(screen.getByRole("link", { name: /see program options/i })).toHaveClass("button-dark");
    expect(screen.getAllByRole("link", { name: /take the free scorecard/i })[0]).toHaveClass("button-primary");
  });
});
