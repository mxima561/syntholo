import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { demoSupportThreads } from "@/lib/demo/data";
import { SupportInbox } from "./support-inbox";

describe("SupportInbox", () => {
  it("adds a customer reply to the shared thread", async () => {
    const user = userEvent.setup();
    render(<SupportInbox currentMember={{ businessName: "Northstar Advisory", id: "member-maria", name: "Maria Chen" }} initialThreads={demoSupportThreads} />);

    await user.type(screen.getByLabelText(/reply to naomi/i), "We added the exception owner.");
    await user.click(screen.getByRole("button", { name: /send reply/i }));

    expect(screen.getAllByText("We added the exception owner.")).toHaveLength(2);
  });
});
