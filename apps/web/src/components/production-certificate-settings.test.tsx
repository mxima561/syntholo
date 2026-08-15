import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionCertificateSettings } from "./production-certificate-settings";

const useAuth = vi.hoisted(() => vi.fn());
vi.mock("@clerk/react", () => ({ useAuth }));

const correlationId = "10000000-0000-4000-8000-000000000001";
const certificateId = "10000000-0000-4000-8000-000000000002";
const completionId = "10000000-0000-4000-8000-000000000003";
const issued = {
  id: certificateId,
  courseCompletionId: completionId,
  status: "issued",
  snapshotRenderable: true,
  recipientName: "Ada Lovelace",
  businessName: "Analytical Engines",
  courseTitle: "AI Operating System Academy",
  courseVersion: 1,
  completedAt: "2026-08-15T12:00:00.000Z",
  issuedAt: "2026-08-15T12:01:00.000Z",
  failureCode: null,
} as const;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-correlation-id": correlationId },
  });
}

function signedIn(sessionId = "session-one") {
  useAuth.mockReturnValue({
    getToken: vi.fn(async () => "member-token"), isLoaded: true, isSignedIn: true, sessionId,
  });
}

afterEach(() => {
  useAuth.mockReset();
  vi.unstubAllGlobals();
});

describe("ProductionCertificateSettings", () => {
  it("loads membership-only name and honest awaiting, pending, failed, and issued states", async () => {
    signedIn();
    const items = [
      { ...issued, id: "10000000-0000-4000-8000-000000000004", courseCompletionId: "10000000-0000-4000-8000-000000000005", status: "awaiting_recipient_name", recipientName: null, issuedAt: null },
      { ...issued, id: "10000000-0000-4000-8000-000000000006", courseCompletionId: "10000000-0000-4000-8000-000000000007", status: "pending", issuedAt: null },
      { ...issued, id: "10000000-0000-4000-8000-000000000008", courseCompletionId: "10000000-0000-4000-8000-000000000009", status: "failed", issuedAt: null, failureCode: "storage_failed" },
      issued,
      { ...issued, id: "10000000-0000-4000-8000-000000000010", courseCompletionId: "10000000-0000-4000-8000-000000000011", status: "failed", snapshotRenderable: false, businessName: null, courseTitle: null, issuedAt: null, failureCode: "snapshot_not_renderable" },
    ];
    const fetcher = vi.fn(async (path: string) => path.endsWith("certificate-recipient-name")
      ? json({ schemaVersion: 1, recipientName: null })
      : json({ items, nextCursor: null }));
    vi.stubGlobal("fetch", fetcher);
    render(<ProductionCertificateSettings />);
    expect(await screen.findByRole("heading", { name: "Certificate settings" })).toBeInTheDocument();
    expect(screen.getByText("Unaccredited certificate of completion")).toBeInTheDocument();
    for (const label of ["Name required", "Preparing", "Needs attention", "Ready to download"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByText("Course title unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download private PDF" })).toBeInTheDocument();
    expect(fetcher.mock.calls.every(([path]) => !String(path).includes("access"))).toBe(true);
  });

  it("canonicalizes and confirms one optimistic recipient name without persisting the raw input", async () => {
    signedIn();
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "PUT") return json({ schemaVersion: 1, recipientName: { version: 1, displayName: "Ada Lovelace", confirmedAt: "2026-08-15T12:00:00.000Z" } });
      return path.endsWith("certificate-recipient-name")
        ? json({ schemaVersion: 1, recipientName: null })
        : json({ items: [], nextCursor: null });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ProductionCertificateSettings />);
    fireEvent.change(await screen.findByLabelText("Recipient name"), { target: { value: " Ada\u00a0Lovelace " } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm recipient name" }));
    await screen.findByText("Recipient name confirmed");
    const put = fetcher.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(put[1]?.body).toBe(JSON.stringify({ expectedVersion: 0, displayName: "Ada Lovelace" }));
    expect(new Headers(put[1]?.headers).get("idempotency-key")).toMatch(/^certificate-name-/u);
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
  });

  it("refreshes an awaiting candidate to pending, then focus-refreshes it to one issued private download", async () => {
    signedIn();
    const awaiting = { ...issued, status: "awaiting_recipient_name" as const, recipientName: null, issuedAt: null, failureCode: null };
    const pending = { ...issued, status: "pending" as const, issuedAt: null, failureCode: null };
    let listReads = 0;
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "PUT") return json({ schemaVersion: 1, recipientName: { version: 1, displayName: "Ada Lovelace", confirmedAt: "2026-08-15T12:00:00.000Z" } });
      if (path.endsWith("certificate-recipient-name")) return json({ schemaVersion: 1, recipientName: null });
      listReads += 1;
      return json({ items: listReads === 1 ? [awaiting] : listReads === 2 ? [pending] : [issued], nextCursor: null });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ProductionCertificateSettings />);
    fireEvent.change(await screen.findByLabelText("Recipient name"), { target: { value: "Ada Lovelace" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm recipient name" }));
    expect(await screen.findByText("Preparing")).toBeInTheDocument();
    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByText("Ready to download")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Download private PDF" })).toHaveLength(1);
  });

  it("keeps the newest issued refresh when an older pending response arrives last", async () => {
    signedIn();
    const pending = { ...issued, status: "pending" as const, issuedAt: null, failureCode: null };
    let listReads = 0;
    let resolveOlder!: (value: Response) => void;
    const older = new Promise<Response>((resolve) => { resolveOlder = resolve; });
    const fetcher = vi.fn((path: string) => {
      if (path.endsWith("certificate-recipient-name")) return Promise.resolve(json({ schemaVersion: 1, recipientName: { version: 1, displayName: "Ada Lovelace", confirmedAt: "2026-08-15T12:00:00.000Z" } }));
      listReads += 1;
      if (listReads === 1) return Promise.resolve(json({ items: [pending], nextCursor: null }));
      if (listReads === 2) return older;
      return Promise.resolve(json({ items: [issued], nextCursor: null }));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ProductionCertificateSettings />);
    await screen.findByText("Preparing");
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(listReads).toBe(2));
    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByText("Ready to download")).toBeInTheDocument();
    resolveOlder(json({ items: [pending], nextCursor: null }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText("Ready to download")).toBeInTheDocument();
    expect(screen.queryByText("Preparing")).not.toBeInTheDocument();
  });

  it("reuses the exact serialized intent after an ambiguous result and preserves a conflict for copy or reload", async () => {
    signedIn();
    let puts = 0;
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        puts += 1;
        if (puts === 1) throw new Error("connection closed after commit");
        return json({ error: { code: "VERSION_CONFLICT", message: "Changed", correlationId } }, 409);
      }
      return path.endsWith("certificate-recipient-name")
        ? json({ schemaVersion: 1, recipientName: puts === 0 ? null : { version: 1, displayName: "Server Name", confirmedAt: "2026-08-15T12:00:00.000Z" } })
        : json({ items: [], nextCursor: null });
    });
    vi.stubGlobal("fetch", fetcher);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<ProductionCertificateSettings />);
    fireEvent.change(await screen.findByLabelText("Recipient name"), { target: { value: "Private draft name" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm recipient name" }));
    const retry = await screen.findByRole("button", { name: "Retry exact confirmation" });
    const first = fetcher.mock.calls.find(([, init]) => init?.method === "PUT")!;
    fireEvent.click(retry);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/changed in another session/iu);
    const requests = fetcher.mock.calls.filter(([, init]) => init?.method === "PUT");
    expect(requests[1]![1]?.body).toBe(first[1]?.body);
    expect(new Headers(requests[1]![1]?.headers).get("idempotency-key"))
      .toBe(new Headers(first[1]?.headers).get("idempotency-key"));
    fireEvent.click(screen.getByRole("button", { name: "Copy unsynced name" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Private draft name"));
    expect(screen.getByText(/Server Name/iu)).toBeInTheDocument();
  });

  it("rejects a late initial list after a Clerk session switch", async () => {
    signedIn("session-one");
    let resolveList!: (value: Response) => void;
    const list = new Promise<Response>((resolve) => { resolveList = resolve; });
    const fetcher = vi.fn((path: string, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      if (path.endsWith("certificate-recipient-name")) return Promise.resolve(json({ schemaVersion: 1, recipientName: null }));
      return authorization === "Bearer new-token" ? Promise.resolve(json({ items: [], nextCursor: null })) : list;
    });
    vi.stubGlobal("fetch", fetcher);
    const { rerender } = render(<ProductionCertificateSettings />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading certificate settings");
    useAuth.mockReturnValue({ getToken: vi.fn(async () => "new-token"), isLoaded: true, isSignedIn: true, sessionId: "session-two" });
    rerender(<ProductionCertificateSettings />);
    await screen.findByLabelText("Recipient name");
    resolveList(json({ items: [issued], nextCursor: null }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Analytical Engines")).not.toBeInTheDocument();
  });

  it("rejects a late name PUT after a Clerk session switch", async () => {
    signedIn("session-one");
    let resolvePut!: (value: Response) => void;
    const pendingPut = new Promise<Response>((resolve) => { resolvePut = resolve; });
    const fetcher = vi.fn((path: string, init?: RequestInit) => {
      if (init?.method === "PUT") return pendingPut;
      const authorization = new Headers(init?.headers).get("authorization");
      return Promise.resolve(path.endsWith("certificate-recipient-name")
        ? json({ schemaVersion: 1, recipientName: authorization === "Bearer new-token" ? null : null })
        : json({ items: [], nextCursor: null }));
    });
    vi.stubGlobal("fetch", fetcher);
    const { rerender } = render(<ProductionCertificateSettings />);
    fireEvent.change(await screen.findByLabelText("Recipient name"), { target: { value: "Old session private name" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm recipient name" }));
    useAuth.mockReturnValue({ getToken: vi.fn(async () => "new-token"), isLoaded: true, isSignedIn: true, sessionId: "session-two" });
    rerender(<ProductionCertificateSettings />);
    resolvePut(json({ schemaVersion: 1, recipientName: { version: 1, displayName: "Old session private name", confirmedAt: "2026-08-15T12:00:00.000Z" } }));
    await screen.findByLabelText("Recipient name");
    expect(screen.queryByDisplayValue("Old session private name")).not.toBeInTheDocument();
    expect(screen.queryByText("Recipient name confirmed")).not.toBeInTheDocument();
  });

  it("aborts and suppresses a late private download after a Clerk session switch", async () => {
    signedIn("session-one");
    let downloadSignal: AbortSignal | undefined;
    const fetcher = vi.fn((path: string, init?: RequestInit) => {
      if (path.endsWith("/download")) {
        downloadSignal = init?.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => downloadSignal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
      }
      return Promise.resolve(path.endsWith("certificate-recipient-name")
        ? json({ schemaVersion: 1, recipientName: { version: 1, displayName: "Ada Lovelace", confirmedAt: "2026-08-15T12:00:00.000Z" } })
        : json({ items: [issued], nextCursor: null }));
    });
    vi.stubGlobal("fetch", fetcher);
    const createObjectURL = vi.fn();
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const { rerender } = render(<ProductionCertificateSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Download private PDF" }));
    useAuth.mockReturnValue({ getToken: vi.fn(async () => "new-token"), isLoaded: true, isSignedIn: true, sessionId: "session-two" });
    rerender(<ProductionCertificateSettings />);
    await waitFor(() => expect(downloadSignal?.aborted).toBe(true));
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    click.mockRestore();
  });

  it("starts one private PDF download and promptly revokes its memory-only object URL", async () => {
    signedIn();
    const bytes = new Uint8Array([37, 80, 68, 70]);
    const fetcher = vi.fn(async (path: string) => {
      if (path.endsWith("/download")) return new Response(bytes, { status: 200, headers: { "content-type": "application/pdf", "content-length": String(bytes.byteLength) } });
      return path.endsWith("certificate-recipient-name")
        ? json({ schemaVersion: 1, recipientName: { version: 1, displayName: "Ada Lovelace", confirmedAt: "2026-08-15T12:00:00.000Z" } })
        : json({ items: [issued], nextCursor: null });
    });
    vi.stubGlobal("fetch", fetcher);
    const createObjectURL = vi.fn(() => "blob:private-certificate");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<ProductionCertificateSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Download private PDF" }));
    await screen.findByText("Private certificate download started");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:private-certificate");
    click.mockRestore();
  });
});
