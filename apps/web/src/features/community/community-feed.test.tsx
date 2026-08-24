import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FeedPost } from "./community-feed";
import { CommunityFeed } from "./community-feed";

const createPostAction = vi.fn<(formData: FormData) => Promise<void>>(async () => undefined);
const toggleLikeAction = vi.fn<(postId: string) => Promise<{ liked: boolean; reactionCount: number }>>(async () => ({ liked: true, reactionCount: 4 }));

vi.mock("@/app/learn/actions", () => ({
  createPostAction: (formData: FormData) => createPostAction(formData),
  toggleLikeAction: (postId: string) => toggleLikeAction(postId),
}));

const seedPosts: FeedPost[] = [
  {
    id: "post-1",
    authorName: "Dana Fox",
    authorBusiness: "Fox Legal",
    initials: "DF",
    space: "Implementation Wins",
    title: "First workflow live",
    body: "Our lead routing is live.",
    reactionCount: 3,
    commentCount: 0,
    createdAt: new Date("2026-08-20T10:00:00Z").toISOString(),
    likedByViewer: false,
  },
];

describe("CommunityFeed", () => {
  it("sends new posts through the server action", async () => {
    const user = userEvent.setup();
    render(<CommunityFeed identity={{ name: "Test Owner", initials: "TO", business: "Test Co" }} initialPosts={seedPosts} />);

    await user.click(screen.getByRole("button", { name: /share an update/i }));
    await user.type(screen.getByLabelText(/post title/i), "Our onboarding test is ready");
    await user.type(screen.getByLabelText(/post body/i), "We would love feedback on our review point.");
    await user.click(screen.getByRole("button", { name: /publish post/i }));

    expect(createPostAction).toHaveBeenCalledTimes(1);
    const formData = createPostAction.mock.calls[0][0];
    expect(formData.get("title")).toBe("Our onboarding test is ready");
    expect(formData.get("space")).toBe("Implementation Wins");
  });

  it("toggles a like optimistically and reconciles with the saved count", async () => {
    const user = userEvent.setup();
    render(<CommunityFeed identity={{ name: "Test Owner", initials: "TO", business: "Test Co" }} initialPosts={seedPosts} />);

    await user.click(screen.getByRole("button", { name: /3/ }));

    expect(toggleLikeAction).toHaveBeenCalledWith("post-1");
    expect(await screen.findByText("4")).toBeInTheDocument();
  });
});
