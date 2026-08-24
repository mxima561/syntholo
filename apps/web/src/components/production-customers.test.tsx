import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionCustomers } from "./production-customers";

afterEach(() => { vi.unstubAllGlobals(); });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("ProductionCustomers", () => {
  it("lists accounts and filters them by search", async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      accounts: [
        { accountId: "10000000-0000-4000-8000-000000000001", accountName: "Karim Aly", status: "active", ownerEmail: "karim@example.test", enrolledCourseCount: 1 },
        { accountId: "10000000-0000-4000-8000-000000000002", accountName: "Other Person", status: "active", ownerEmail: "other@example.test", enrolledCourseCount: 0 },
      ],
    }));
    vi.stubGlobal("fetch", fetcher);
    render(<ProductionCustomers />);

    await screen.findByText("Karim Aly");
    expect(screen.getByText("Other Person")).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith("/v1/staff/accounts", expect.objectContaining({ method: "GET" }));

    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "karim" } });
    await waitFor(() => expect(screen.queryByText("Other Person")).not.toBeInTheDocument());
    expect(screen.getByText("Karim Aly")).toBeInTheDocument();
  });

  it("shows an error when the accounts request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    render(<ProductionCustomers />);
    await screen.findByRole("alert");
  });

  it("shows an error when the accounts payload is not a staff account list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ accounts: [{ id: "not-an-account" }] })));
    render(<ProductionCustomers />);
    await screen.findByRole("alert");
  });
});
