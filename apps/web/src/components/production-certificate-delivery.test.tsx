import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionCertificateDelivery } from "./production-certificate-delivery";

afterEach(() => { vi.unstubAllGlobals(); });

describe("ProductionCertificateDelivery", () => {
  it("requests one honest pending delivery with no destination or provider claim", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Response(JSON.stringify({ status: "delivery_pending" }), {
        status: 202, headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ProductionCertificateDelivery />);
    fireEvent.change(screen.getByLabelText("Certificate ID"), { target: { value: "10000000-0000-4000-8000-000000000001" } });
    fireEvent.change(screen.getByLabelText("Recovery reason"), { target: { value: "Customer requested a private delivery recovery" } });
    fireEvent.click(screen.getByRole("button", { name: "Request delivery recovery" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Delivery pending");
    expect(screen.getByText("No email has been sent in this release.")).toBeInTheDocument();
    const [path, init] = fetcher.mock.calls[0]!;
    expect(path).toBe("/v1/staff/certificates/10000000-0000-4000-8000-000000000001/deliveries");
    expect(init?.body).toBe(JSON.stringify({ reason: "Customer requested a private delivery recovery" }));
    expect(new Headers(init?.headers).get("x-syntholo-csrf")).toBe("1");
    expect(new Headers(init?.headers).get("idempotency-key")).toMatch(/^certificate-delivery-/u);
    expect(screen.queryByLabelText(/email|destination/iu)).not.toBeInTheDocument();
  });

  it("retries an ambiguous delivery request with the byte-identical body and key", async () => {
    let calls = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      calls += 1;
      if (calls === 1) throw new Error("connection closed after commit");
      return new Response(JSON.stringify({ status: "delivery_pending" }), { status: 202, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ProductionCertificateDelivery />);
    fireEvent.change(screen.getByLabelText("Certificate ID"), { target: { value: "10000000-0000-4000-8000-000000000001" } });
    fireEvent.change(screen.getByLabelText("Recovery reason"), { target: { value: "Customer requested recovery" } });
    fireEvent.click(screen.getByRole("button", { name: "Request delivery recovery" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry exact request" }));
    await screen.findByText("No email has been sent in this release.");
    expect(fetcher.mock.calls[1]![1]?.body).toBe(fetcher.mock.calls[0]![1]?.body);
    expect(new Headers(fetcher.mock.calls[1]![1]?.headers).get("idempotency-key"))
      .toBe(new Headers(fetcher.mock.calls[0]![1]?.headers).get("idempotency-key"));
  });

  it("rejects invalid IDs and reasons locally without a request", async () => {
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return Promise.resolve(new Response());
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ProductionCertificateDelivery />);
    fireEvent.change(screen.getByLabelText("Certificate ID"), { target: { value: "not-an-id" } });
    fireEvent.change(screen.getByLabelText("Recovery reason"), { target: { value: " " } });
    fireEvent.click(screen.getByRole("button", { name: "Request delivery recovery" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("not sent"));
    expect(fetcher).not.toHaveBeenCalled();
  });
});
