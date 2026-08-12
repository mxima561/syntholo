import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "./button";

describe("Button", () => {
  it("exposes the primary action as an accessible button", () => {
    render(<Button>Continue lesson</Button>);

    expect(screen.getByRole("button", { name: "Continue lesson" })).toHaveClass(
      "button-primary",
    );
  });
});

