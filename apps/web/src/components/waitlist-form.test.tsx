import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WAITLIST_COPY, WaitlistForm } from "./waitlist-form";

afterEach(() => { vi.unstubAllGlobals(); });

describe("WaitlistForm", () => {
  it("submits an email to the waitlist route", async () => {
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({
        status: "subscribed",
        email: "owner@example.test",
        createdAt: "2026-08-21T16:00:00.000Z",
        source: "school",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetcher);
    render(<WaitlistForm />);
    expect(screen.getByRole("heading", { name: WAITLIST_COPY.headline })).toBeInTheDocument();
    expect(screen.getByText(WAITLIST_COPY.subhead)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "owner@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: WAITLIST_COPY.cta }));
    await screen.findByText(WAITLIST_COPY.success);
    expect(fetcher).toHaveBeenCalledWith("/v1/waitlist", expect.objectContaining({
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      body: JSON.stringify({ email: "owner@example.test", source: "school" }),
    }));
  });

  it("shows the same success copy for an already-subscribed email", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({
        status: "already-subscribed",
        email: "owner@example.test",
        createdAt: "2026-08-21T16:00:00.000Z",
        source: "school",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));
    render(<WaitlistForm />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "owner@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: WAITLIST_COPY.cta }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/you're on the list/i));
  });
});
