import { readFileSync } from "node:fs";
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

  it("keeps small member-facing actions at the readable control floor", () => {
    render(<Button size="small">Save settings</Button>);

    expect(screen.getByRole("button", { name: "Save settings" })).toHaveClass("button-small");
    expect(readFileSync("src/styles/base.css", "utf8")).toContain(
      ".button-small { min-height: 44px; padding-inline: 13px; font-size: 13px; }",
    );
  });
});
