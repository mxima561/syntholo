import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LiveSchedule } from "./live-schedule";

vi.mock("@/app/learn/actions", () => ({
  rsvpSessionAction: vi.fn(async () => ({ reserved: true })),
}));

describe("LiveSchedule", () => {
  it("confirms an RSVP for a scheduled office hour", async () => {
    const user = userEvent.setup();
    render(
      <LiveSchedule
        sessions={[{
          id: "session-americas",
          title: "Workflow office hours",
          description: "Bring one workflow map.",
          startsAt: "2026-09-03T17:00:00.000Z",
          region: "Americas",
          hostName: "Naomi Reed",
          status: "scheduled",
          rsvpCount: 2,
          reservedByViewer: false,
          recordingUrl: null,
        }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /reserve my seat/i }));

    expect(screen.getByRole("button", { name: /seat reserved/i })).toBeDisabled();
  });
});
