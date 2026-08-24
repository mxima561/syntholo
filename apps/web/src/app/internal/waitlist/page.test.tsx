import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WAITLIST_COPY } from "@/components/waitlist-form";
import InternalWaitlistPage, { metadata } from "./page";

describe("internal waitlist page", () => {
  it("is an unindexed review page using the school waitlist copy", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    render(<InternalWaitlistPage />);
    expect(screen.getByRole("heading", { name: WAITLIST_COPY.headline })).toBeInTheDocument();
    expect(screen.getByText(WAITLIST_COPY.subhead)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: WAITLIST_COPY.cta })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /pricing|checkout/i })).not.toBeInTheDocument();
  });
});
