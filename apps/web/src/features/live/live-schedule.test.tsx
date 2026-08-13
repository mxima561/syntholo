import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { demoSessions } from "@/lib/demo/data";
import { LiveSchedule } from "./live-schedule";

describe("LiveSchedule", () => {
  it("confirms an RSVP for a scheduled office hour", async () => {
    const user = userEvent.setup();
    render(<LiveSchedule sessions={demoSessions} />);

    await user.click(screen.getAllByRole("button", { name: /reserve my seat/i })[0]);

    expect(screen.getByRole("button", { name: /seat reserved/i })).toBeDisabled();
  });
});
