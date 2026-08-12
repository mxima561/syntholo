import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ScorecardClient } from "./scorecard-client";

describe("ScorecardClient", () => {
  it("moves to the next question after an owner chooses an answer", async () => {
    const user = userEvent.setup();
    render(<ScorecardClient />);

    expect(screen.getByText("Question 1 of 20")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /we have a clear plan/i }));

    expect(screen.getByText("Question 2 of 20")).toBeInTheDocument();
  });

  it("offers a previous-question control after progress begins", async () => {
    const user = userEvent.setup();
    render(<ScorecardClient />);

    await user.click(screen.getByRole("button", { name: /we have a clear plan/i }));
    await user.click(screen.getByRole("button", { name: /back/i }));

    expect(screen.getByText("Question 1 of 20")).toBeInTheDocument();
  });
});

