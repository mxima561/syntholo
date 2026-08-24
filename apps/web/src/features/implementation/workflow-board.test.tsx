import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkflowBoard } from "./workflow-board";

const setWorkflowStatusAction = vi.fn<(workflowId: string, status: string) => Promise<void>>(async () => undefined);

vi.mock("@/app/learn/actions", () => ({
  createWorkflowAction: vi.fn(async () => undefined),
  saveWorkflowAction: vi.fn(async () => undefined),
  setWorkflowStatusAction: (workflowId: string, status: string) => setWorkflowStatusAction(workflowId, status),
}));

describe("WorkflowBoard", () => {
  it("moves a draft workflow into testing", async () => {
    const user = userEvent.setup();
    render(
      <WorkflowBoard
        initialWorkflows={[{
          id: "wf-weekly",
          name: "Weekly owner brief",
          engine: "management",
          problem: "Reporting takes Friday afternoon.",
          owner: "Test Owner",
          approvedTools: ["Sheets"],
          humanReviewPoint: "Owner checks recommendations",
          baseline: "3.5 hours",
          target: "45 minutes",
          status: "draft",
        }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /move weekly owner brief to testing/i }));

    expect(screen.getByText("Testing", { selector: "i" })).toBeInTheDocument();
    expect(setWorkflowStatusAction).toHaveBeenCalledWith("wf-weekly", "testing");
  });
});
