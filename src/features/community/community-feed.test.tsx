import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { demoCommunityPosts } from "@/lib/demo/data";
import { CommunityFeed } from "./community-feed";

describe("CommunityFeed", () => {
  it("publishes a new member post into the selected space", async () => {
    const user = userEvent.setup();
    render(<CommunityFeed initialPosts={demoCommunityPosts} />);

    await user.click(screen.getByRole("button", { name: /share an update/i }));
    await user.type(screen.getByLabelText(/post title/i), "Our onboarding test is ready");
    await user.type(screen.getByLabelText(/post body/i), "We would love feedback on our review point.");
    await user.click(screen.getByRole("button", { name: /publish post/i }));

    expect(screen.getByText("Our onboarding test is ready")).toBeInTheDocument();
  });
});
