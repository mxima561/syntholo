import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { InboxThread } from "./support-inbox";
import { SupportInbox } from "./support-inbox";

const createThreadAction = vi.fn<(formData: FormData) => Promise<void>>(async () => undefined);
const replyToThreadAction = vi.fn<(formData: FormData) => Promise<void>>(async () => undefined);

vi.mock("@/app/learn/actions", () => ({
  createThreadAction: (formData: FormData) => createThreadAction(formData),
  replyToThreadAction: (formData: FormData) => replyToThreadAction(formData),
}));

const seedThreads: InboxThread[] = [
  {
    id: "thread-1",
    subject: "Welcome to Syntholo",
    category: "course",
    status: "waiting_on_customer",
    coachName: "Naomi Reed",
    updatedAt: new Date("2026-08-20T10:00:00Z").toISOString(),
    messages: [
      {
        id: "message-1",
        authorName: "Naomi Reed",
        authorRole: "coach",
        body: "Welcome! Ask me anything about your first workflow.",
        createdAt: new Date("2026-08-20T10:00:00Z").toISOString(),
      },
    ],
  },
];

describe("SupportInbox", () => {
  it("sends a customer reply through the server action", async () => {
    const user = userEvent.setup();
    render(<SupportInbox identity={{ name: "Test Owner", initials: "TO", business: "Test Co" }} threads={seedThreads} />);

    await user.type(screen.getByLabelText(/reply to naomi/i), "We added the exception owner.");
    await user.click(screen.getByRole("button", { name: /send reply/i }));

    expect(replyToThreadAction).toHaveBeenCalledTimes(1);
    const formData = replyToThreadAction.mock.calls[0][0];
    expect(formData.get("threadId")).toBe("thread-1");
    expect(formData.get("body")).toBe("We added the exception owner.");
  });

  it("starts a new conversation with the coach", async () => {
    const user = userEvent.setup();
    render(<SupportInbox identity={{ name: "Test Owner", initials: "TO", business: "Test Co" }} threads={seedThreads} />);

    await user.click(screen.getByRole("button", { name: /start a new support conversation/i }));
    await user.type(screen.getByLabelText(/conversation subject/i), "Review my launch plan");
    await user.type(screen.getByLabelText(/first message/i), "Here is what we are launching next week.");
    await user.click(screen.getByRole("button", { name: /send to coach/i }));

    expect(createThreadAction).toHaveBeenCalledTimes(1);
    const formData = createThreadAction.mock.calls[0][0];
    expect(formData.get("subject")).toBe("Review my launch plan");
  });
});
