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

  it("maps human and milestone actions to semantic classes", () => {
    render(
      <>
        <Button variant="human">Ask a coach</Button>
        <Button variant="milestone">Add to calendar</Button>
      </>,
    );

    expect(screen.getByRole("button", { name: "Ask a coach" })).toHaveClass("button-human");
    expect(screen.getByRole("button", { name: "Add to calendar" })).toHaveClass(
      "button-milestone",
    );
  });
});
