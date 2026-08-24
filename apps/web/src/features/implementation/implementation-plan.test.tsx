import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ImplementationPlan } from "./implementation-plan";

vi.mock("@/app/learn/actions", () => ({
  saveArtifactAction: vi.fn(async () => undefined),
  requestArtifactReviewAction: vi.fn(async () => undefined),
}));

describe("ImplementationPlan", () => {
  it("styles the coach review request as a human action", () => {
    render(
      <ImplementationPlan
        completedLessons={2}
        liveWorkflows={0}
        initialArtifacts={[{
          id: "ai-policy",
          kind: "ai_policy",
          title: "Team AI policy",
          status: "draft",
          version: 1,
          body: "Draft policy",
          reviewStatus: "none",
          updatedBy: "Test Owner",
          updatedAt: new Date().toISOString(),
        }]}
      />,
    );

    expect(screen.getByRole("button", { name: /ask coach to review/i })).toHaveClass("button-human");
  });

  it("switches the open document from the output list", async () => {
    const user = userEvent.setup();
    render(
      <ImplementationPlan
        completedLessons={2}
        liveWorkflows={0}
        initialArtifacts={[
          {
            id: "map",
            kind: "readiness_map",
            title: "Readiness & opportunity map",
            status: "draft",
            version: 1,
            body: "Map body",
            reviewStatus: "none",
            updatedBy: "Test Owner",
            updatedAt: new Date().toISOString(),
          },
          {
            id: "enablement",
            kind: "enablement_checklist",
            title: "Team enablement checklist",
            status: "not_started",
            version: 1,
            body: "Checklist body",
            reviewStatus: "none",
            updatedBy: "Test Owner",
            updatedAt: new Date().toISOString(),
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /team enablement checklist/i }));
    expect(screen.getByRole("heading", { name: /team enablement checklist/i })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /team enablement checklist draft/i })).toHaveValue("Checklist body");
  });
});
