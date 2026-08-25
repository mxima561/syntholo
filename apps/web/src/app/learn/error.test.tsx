import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import LearnErrorPage from "./error";

describe("learn error UI", () => {
  it("renders unavailable copy without demo fixtures", () => {
    const retry = vi.fn();
    const { container } = render(
      <LearnErrorPage error={new Error("DATABASE_URL is not configured")} retry={retry} />,
    );

    expect(screen.getByRole("heading", { name: /academy is temporarily unavailable/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to syntholo/i })).toHaveAttribute("href", "/");
    expect(container.textContent).not.toMatch(/Northstar/i);
    expect(container.textContent).not.toContain("maria@northstar");
    expect(container.textContent).not.toMatch(/Maria Chen/i);
  });
});
