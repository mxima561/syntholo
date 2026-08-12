import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { demoArtifacts } from "@/lib/demo/data";
import { WorkflowBoard } from "./workflow-board";

describe("WorkflowBoard", () => {
  it("moves a draft workflow into testing", async () => {
    const user = userEvent.setup();
    const workflows = demoArtifacts.find((artifact) => artifact.kind === "workflow_portfolio")?.workflows ?? [];
    render(<WorkflowBoard initialWorkflows={workflows} />);

    await user.click(screen.getByRole("button", { name: /move weekly owner brief to testing/i }));

    expect(screen.getAllByText("Testing", { selector: "i" })).toHaveLength(2);
  });
});
