import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemberEntryCta } from "./member-entry-cta";

const getSession = vi.hoisted(() => vi.fn());

vi.mock("@syntholo/auth/client", () => ({
  authClient: { getSession },
}));

describe("MemberEntryCta", () => {
  beforeEach(() => {
    getSession.mockReset();
  });

  it("keeps the marketing sign-in path until a session is confirmed", () => {
    getSession.mockReturnValue(new Promise(() => undefined));
    render(<MemberEntryCta />);
    expect(screen.getByRole("link", { name: /member sign in/i })).toHaveAttribute("href", "/signin");
  });

  it("sends a signed-in visitor to the academy instead of another sign-in", async () => {
    getSession.mockResolvedValue({ data: { user: { id: "user_1" } } });
    render(<MemberEntryCta />);
    await waitFor(() => {
      expect(screen.getByRole("link", { name: /go to academy/i })).toHaveAttribute("href", "/learn");
    });
  });
});
