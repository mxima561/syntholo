import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ClaimPage from "./page";

describe("ClaimPage", () => {
  it("does not send buyers to checkout or pricing", () => {
    render(<ClaimPage />);

    expect(screen.getByRole("link", { name: /view program options/i })).toHaveAttribute("href", "/");
  });
});
