import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { demoArtifacts } from "@/lib/demo/data";
import { ImplementationPlan } from "./implementation-plan";

describe("ImplementationPlan", () => {
  it("styles the coach review request as a human action", () => {
    render(<ImplementationPlan initialArtifacts={demoArtifacts} />);

    expect(screen.getByRole("button", { name: /ask coach to review/i })).toHaveClass("button-human");
  });
});
