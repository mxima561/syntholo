import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionImplementationWorkspace } from "./production-implementation-workspace";

const useAuth = vi.hoisted(() => vi.fn());
vi.mock("@clerk/react", () => ({ useAuth }));

const kinds = ["readiness_map", "ai_policy", "workflow_portfolio", "enablement_checklist", "roadmap"] as const;
const summaries = kinds.map((kind, index) => ({
  id: `30000000-0000-4000-8000-00000000000${index + 1}`,
  kind,
  title: ["Readiness map", "AI policy", "Workflow portfolio", "Enablement checklist", "90-day roadmap"][index]!,
  currentVersion: 0,
  currentState: null,
  currentVersionId: null,
  updatedAt: null,
  authorLabel: null,
}));
const list = {
  schemaVersion: 1,
  items: summaries,
  nextCursor: null,
  implementationCompletion: { completed: false, completedAt: null },
} as const;
const emptyReadiness = { kind: "readiness_map", priorities: [], notes: "" } as const;

function savedReadiness(notes: string) {
  return {
    schemaVersion: 1,
    artifact: { ...summaries[0], currentVersion: 1, currentState: "draft", currentVersionId: "40000000-0000-4000-8000-000000000002", updatedAt: "2026-08-15T12:00:00.000Z", authorLabel: "You" },
    version: { id: "40000000-0000-4000-8000-000000000002", version: 1, state: "draft", contentHash: "a".repeat(64), createdAt: "2026-08-15T12:00:00.000Z", authorLabel: "You" },
    content: { ...emptyReadiness, notes },
    implementationCompletion: { completed: false, completedAt: null },
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-correlation-id": "40000000-0000-4000-8000-000000000001" },
  });
}

function signedIn(sessionId = "session-one") {
  useAuth.mockReturnValue({
    getToken: vi.fn(async () => "clerk-token"),
    isLoaded: true,
    isSignedIn: true,
    sessionId,
  });
}

afterEach(() => {
  useAuth.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ProductionImplementationWorkspace", () => {
  it("loads the five actor-owned roots and structured detail with a Clerk bearer", async () => {
    signedIn();
    const fetcher = vi.fn(async (path: string) => path === "/v1/member/artifacts"
      ? json(list)
      : json({ schemaVersion: 1, artifact: summaries[0], content: null }));
    vi.stubGlobal("fetch", fetcher);
    render(<ProductionImplementationWorkspace view="plan" />);
    expect(await screen.findByRole("heading", { name: "Readiness map" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(5);
    for (const tab of screen.getAllByRole("tab")) {
      const panelId = tab.getAttribute("aria-controls");
      expect(panelId).not.toBeNull();
      expect(document.getElementById(panelId!)).toHaveAttribute("role", "tabpanel");
    }
    expect(screen.getByLabelText("Notes")).toHaveValue("");
    expect(fetcher).toHaveBeenCalledWith("/v1/member/artifacts", expect.objectContaining({
      cache: "no-store", credentials: "omit",
      headers: { authorization: "Bearer clerk-token" },
    }));
    expect(fetcher).toHaveBeenCalledWith(`/v1/member/artifacts/${summaries[0]!.id}`, expect.anything());
    expect(document.body).not.toHaveTextContent(/Naomi|coach review|Maria|Northstar/iu);
  });

  it("retries one immutable autosave intent and keeps edits made while it is in flight dirty", async () => {
    signedIn();
    let resolveSave!: (value: Response) => void;
    const save = new Promise<Response>((resolve) => { resolveSave = resolve; });
    const fetcher = vi.fn((path: string, init?: RequestInit) => {
      if (path === "/v1/member/artifacts") return Promise.resolve(json(list));
      if (init?.method === "POST") return save;
      return Promise.resolve(json({ schemaVersion: 1, artifact: summaries[0], content: null }));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ProductionImplementationWorkspace view="plan" />);
    const notes = await screen.findByLabelText("Notes");
    fireEvent.change(notes, { target: { value: "First edit" } });
    await waitFor(() => expect(fetcher.mock.calls.some((call) => call[1]?.method === "POST")).toBe(true), { timeout: 2_000 });
    const firstPost = fetcher.mock.calls.find((call) => call[1]?.method === "POST")!;
    fireEvent.change(notes, { target: { value: "Second edit" } });
    resolveSave(json(savedReadiness("First edit"), 201));
    await waitFor(() => expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(2), { timeout: 2_000 });
    const posts = fetcher.mock.calls.filter((call) => call[1]?.method === "POST");
    expect(JSON.parse(String(firstPost[1]?.body))).toMatchObject({ expectedVersion: 0, content: { notes: "First edit" } });
    expect(JSON.parse(String(posts[1]![1]?.body))).toMatchObject({ expectedVersion: 1, content: { notes: "Second edit" } });
    expect(notes).toHaveValue("Second edit");
  });

  it("reuses the byte-identical body and idempotency key after an ambiguous save", async () => {
    signedIn();
    let postCount = 0;
    const fetcher = vi.fn((path: string, init?: RequestInit) => {
      if (path === "/v1/member/artifacts") return Promise.resolve(json(list));
      if (init?.method !== "POST") return Promise.resolve(json({ schemaVersion: 1, artifact: summaries[0], content: null }));
      postCount += 1;
      return postCount === 1
        ? Promise.reject(new Error("connection closed after commit"))
        : postCount === 2
          ? Promise.resolve(json({ error: { code: "IDEMPOTENCY_IN_PROGRESS", message: "In progress", correlationId: "40000000-0000-4000-8000-000000000001" } }, 409))
          : Promise.resolve(json(savedReadiness("Ambiguous edit"), 201));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ProductionImplementationWorkspace view="plan" />);
    fireEvent.change(await screen.findByLabelText("Notes"), { target: { value: "Ambiguous edit" } });
    const retry = await screen.findByRole("button", { name: "Retry exact save" }, { timeout: 2_000 });
    const first = fetcher.mock.calls.filter((call) => call[1]?.method === "POST")[0]!;
    fireEvent.click(retry);
    await waitFor(() => expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(2));
    fireEvent.click(await screen.findByRole("button", { name: "Retry exact save" }));
    await waitFor(() => expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(3));
    const retried = fetcher.mock.calls.filter((call) => call[1]?.method === "POST");
    expect(retried[1]![1]?.body).toBe(first[1]?.body);
    expect(retried[2]![1]?.body).toBe(first[1]?.body);
    expect(new Headers(retried[2]![1]?.headers).get("idempotency-key"))
      .toBe(new Headers(first[1]?.headers).get("idempotency-key"));
  });

  it("preserves an unsynced draft on 409 and never shows it after the Clerk session changes", async () => {
    signedIn("session-one");
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/v1/member/artifacts") return json(list);
      if (init?.method === "POST") return json({ error: { code: "VERSION_CONFLICT", message: "Changed", correlationId: "40000000-0000-4000-8000-000000000001" } }, 409);
      return json({ schemaVersion: 1, artifact: summaries[0], content: null });
    });
    vi.stubGlobal("fetch", fetcher);
    const { rerender } = render(<ProductionImplementationWorkspace view="plan" />);
    const notes = await screen.findByLabelText("Notes");
    fireEvent.change(notes, { target: { value: "Private unsynced draft" } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/changed in another session/iu), { timeout: 2_000 });
    expect(notes).toHaveValue("Private unsynced draft");
    expect(screen.getByRole("region", { name: "Conflict comparison" })).toHaveTextContent("Your unsynced draft");
    const postCount = fetcher.mock.calls.filter((call) => call[1]?.method === "POST").length;
    fireEvent.change(notes, { target: { value: "Still private and conflicted" } });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(postCount);

    useAuth.mockReturnValue({ getToken: vi.fn(async () => "new-token"), isLoaded: true, isSignedIn: true, sessionId: "session-two" });
    rerender(<ProductionImplementationWorkspace view="plan" />);
    expect(screen.queryByDisplayValue("Private unsynced draft")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Loading your implementation workspace/iu);
  });

  it("keeps a confirmed conflict sticky when refreshing the latest comparison fails", async () => {
    signedIn();
    let detailReads = 0;
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/v1/member/artifacts") return json(list);
      if (init?.method === "POST") return json({ error: { code: "VERSION_CONFLICT", message: "Changed", correlationId: "40000000-0000-4000-8000-000000000001" } }, 409);
      detailReads += 1;
      if (detailReads === 1) return json({ schemaVersion: 1, artifact: summaries[0], content: null });
      throw new Error("comparison transport failed");
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ProductionImplementationWorkspace view="plan" />);
    fireEvent.change(await screen.findByLabelText("Notes"), { target: { value: "Preserved conflict draft" } });
    expect(await screen.findByRole("alert", {}, { timeout: 2_000 })).toHaveTextContent(/changed in another session/iu);
    expect(screen.getByRole("region", { name: "Conflict comparison" })).toHaveTextContent("Latest comparison unavailable");
    expect(screen.queryByText(/Save result unknown/iu)).not.toBeInTheDocument();
  });

  it("renders the freshly fetched server content in the conflict comparison", async () => {
    signedIn();
    let detailReads = 0;
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/v1/member/artifacts") return json(list);
      if (init?.method === "POST") return json({ error: { code: "VERSION_CONFLICT", message: "Changed", correlationId: "40000000-0000-4000-8000-000000000001" } }, 409);
      detailReads += 1;
      return detailReads === 1
        ? json({ schemaVersion: 1, artifact: summaries[0], content: null })
        : json({ schemaVersion: 1, artifact: savedReadiness("Teammate latest").artifact, content: { ...emptyReadiness, notes: "Teammate latest" } });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ProductionImplementationWorkspace view="plan" />);
    fireEvent.change(await screen.findByLabelText("Notes"), { target: { value: "My preserved draft" } });
    expect(await screen.findByRole("region", { name: "Conflict comparison" }, { timeout: 2_000 })).toHaveTextContent("Teammate latest");
  });

  it("opens the exact workflow portfolio and exposes every PRD workflow field", async () => {
    signedIn();
    const portfolio = summaries[2]!;
    const fetcher = vi.fn(async (path: string) => path === "/v1/member/artifacts"
      ? json(list)
      : json({ schemaVersion: 1, artifact: portfolio, content: null }));
    vi.stubGlobal("fetch", fetcher);
    render(<ProductionImplementationWorkspace view="workflows" />);
    expect(await screen.findByRole("heading", { name: "Workflow portfolio" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add workflow" }));
    for (const label of ["Name", "Problem", "Trigger", "Owner", "Approved tools", "Steps", "Human review point", "Safety notes", "Baseline", "Target", "Lifecycle state", "Test status", "Launch date"]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    const tabs = screen.getAllByRole("tab");
    fireEvent.keyDown(tabs[2]!, { key: "ArrowRight" });
    expect(tabs[3]).toHaveAttribute("aria-selected", "true");
    expect(tabs[3]).toHaveFocus();
  });

  it("identifies invalid workflow fields and links controls to an accessible error summary", async () => {
    signedIn();
    const portfolio = summaries[2]!;
    const fetcher = vi.fn(async (path: string) => path === "/v1/member/artifacts"
      ? json(list)
      : json({ schemaVersion: 1, artifact: portfolio, content: null }));
    vi.stubGlobal("fetch", fetcher);
    render(<ProductionImplementationWorkspace view="workflows" />);
    fireEvent.click(await screen.findByRole("button", { name: "Add workflow" }));
    fireEvent.change(screen.getByLabelText("Lifecycle state"), { target: { value: "live" } });
    fireEvent.click(screen.getByRole("button", { name: "Save final version" }));
    const summary = await screen.findByRole("alert");
    expect(summary).toHaveTextContent(/workflows\.0\.name/iu);
    expect(screen.getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Name")).toHaveAttribute("aria-describedby", expect.stringContaining("implementation-validation"));
    expect(screen.getByLabelText("Test status")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Launch date")).toHaveAttribute("aria-invalid", "true");
  });

  it("links every nested final-completeness failure to its structured control", async () => {
    signedIn();
    const fetcher = vi.fn(async (path: string) => {
      if (path === "/v1/member/artifacts") return json(list);
      const artifact = summaries.find(({ id }) => path.endsWith(id)) ?? summaries[0]!;
      return json({ schemaVersion: 1, artifact, content: null });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ProductionImplementationWorkspace view="plan" />);

    fireEvent.change(await screen.findByLabelText("Notes"), { target: { value: "Ready" } });
    fireEvent.click(screen.getByRole("button", { name: "Add priority" }));
    fireEvent.change(screen.getByLabelText("Current state"), { target: { value: "Manual" } });
    fireEvent.change(screen.getByLabelText("Target outcome"), { target: { value: "Automated" } });
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "Operations" } });
    fireEvent.click(screen.getByRole("button", { name: "Save final version" }));
    expect(screen.getByLabelText("Opportunity")).toHaveAttribute("aria-invalid", "true");

    fireEvent.click(screen.getByRole("tab", { name: /AI policy/iu }));
    fireEvent.change(await screen.findByLabelText("Purpose"), { target: { value: "Safe use" } });
    fireEvent.change(screen.getByLabelText("Approved uses"), { target: { value: "\n" } });
    fireEvent.change(screen.getByLabelText("Prohibited uses"), { target: { value: "No secrets" } });
    fireEvent.change(screen.getByLabelText("Human review rules"), { target: { value: "Review first" } });
    fireEvent.click(screen.getByRole("button", { name: "Save final version" }));
    expect(screen.getByLabelText("Approved uses")).toHaveAttribute("aria-invalid", "true");

    fireEvent.click(screen.getByRole("tab", { name: /Enablement checklist/iu }));
    fireEvent.change(await screen.findByLabelText("Owner"), { target: { value: "Operations" } });
    fireEvent.click(screen.getByRole("button", { name: "Add checklist item" }));
    fireEvent.click(screen.getByRole("button", { name: "Save final version" }));
    expect(screen.getByLabelText("Item 1")).toHaveAttribute("aria-invalid", "true");

    fireEvent.click(screen.getByRole("tab", { name: /90-day roadmap/iu }));
    fireEvent.change(await screen.findByLabelText("Objective"), { target: { value: "Launch" } });
    fireEvent.click(screen.getByRole("button", { name: "Add milestone" }));
    fireEvent.click(screen.getByRole("button", { name: "Save final version" }));
    expect(screen.getByLabelText("Outcome")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Owner")).toHaveAttribute("aria-invalid", "true");
  });

  it("preserves the current memory-only draft when another artifact cannot be loaded", async () => {
    signedIn();
    const fetcher = vi.fn(async (path: string) => {
      if (path === "/v1/member/artifacts") return json(list);
      if (path.endsWith(summaries[1]!.id)) throw new Error("temporary detail failure");
      return json({ schemaVersion: 1, artifact: summaries[0], content: null });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ProductionImplementationWorkspace view="plan" />);
    fireEvent.change(await screen.findByLabelText("Notes"), { target: { value: "Do not lose this draft" } });
    fireEvent.click(screen.getByRole("tab", { name: /AI policy/iu }));
    expect(await screen.findByText(/document could not be loaded/iu)).toBeInTheDocument();
    expect(screen.getByLabelText("Notes")).toHaveValue("Do not lose this draft");
    expect(screen.queryByRole("heading", { name: "Implementation workspace unavailable" })).not.toBeInTheDocument();
  });

  it("keeps a conflict draft when history, reload, and clipboard recovery are unavailable", async () => {
    signedIn();
    let detailReads = 0;
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/v1/member/artifacts") return json(list);
      if (init?.method === "POST") return json({ error: { code: "VERSION_CONFLICT", message: "Changed", correlationId: "40000000-0000-4000-8000-000000000001" } }, 409);
      detailReads += 1;
      if (detailReads <= 2) return json({ schemaVersion: 1, artifact: summaries[0], content: null });
      throw new Error("recovery unavailable");
    });
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    render(<ProductionImplementationWorkspace view="plan" />);
    fireEvent.change(await screen.findByLabelText("Notes"), { target: { value: "Still preserved" } });
    await screen.findByRole("alert", {}, { timeout: 2_000 });
    fireEvent.click(screen.getByRole("button", { name: "Copy unsynced draft" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be copied/iu);
    fireEvent.click(screen.getByRole("button", { name: "View version history" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/history unavailable/iu);
    fireEvent.click(screen.getByRole("button", { name: "Reload server version" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/reload unavailable/iu);
    expect(screen.getByLabelText("Notes")).toHaveValue("Still preserved");
  });

  it("cannot land a late POST or late initial 401 after the Clerk session changes", async () => {
    let resolveOldPost!: (value: Response) => void;
    let resolveOldList!: (value: Response) => void;
    const oldPost = new Promise<Response>((resolve) => { resolveOldPost = resolve; });
    const oldList = new Promise<Response>((resolve) => { resolveOldList = resolve; });
    const sessionBSummary = { ...summaries[0]!, currentVersion: 1, currentState: "draft" as const, currentVersionId: "40000000-0000-4000-8000-000000000003", updatedAt: "2026-08-15T13:00:00.000Z", authorLabel: "You" as const };
    const sessionBList = { ...list, items: [sessionBSummary, ...summaries.slice(1)] };
    let deferOldList = false;
    const fetcher = vi.fn((path: string, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization === "Bearer token-a" && path === "/v1/member/artifacts" && deferOldList) return oldList;
      if (path === "/v1/member/artifacts") return Promise.resolve(json(authorization === "Bearer token-b" ? sessionBList : list));
      if (init?.method === "POST") return oldPost;
      return Promise.resolve(json(authorization === "Bearer token-b"
        ? { schemaVersion: 1, artifact: sessionBSummary, content: { ...emptyReadiness, notes: "Session B content" } }
        : { schemaVersion: 1, artifact: summaries[0], content: null }));
    });
    vi.stubGlobal("fetch", fetcher);
    useAuth.mockReturnValue({ getToken: vi.fn(async () => "token-a"), isLoaded: true, isSignedIn: true, sessionId: "session-a" });
    const rendered = render(<ProductionImplementationWorkspace view="plan" />);
    fireEvent.change(await screen.findByLabelText("Notes"), { target: { value: "Session A pending" } });
    await waitFor(() => expect(fetcher.mock.calls.some((call) => call[1]?.method === "POST")).toBe(true), { timeout: 2_000 });

    useAuth.mockReturnValue({ getToken: vi.fn(async () => "token-b"), isLoaded: true, isSignedIn: true, sessionId: "session-b" });
    rendered.rerender(<ProductionImplementationWorkspace view="plan" />);
    expect(await screen.findByDisplayValue("Session B content")).toBeInTheDocument();
    resolveOldPost(json(savedReadiness("Session A pending"), 201));
    await waitFor(() => expect(screen.getByLabelText("Notes")).toHaveValue("Session B content"));

    deferOldList = true;
    useAuth.mockReturnValue({ getToken: vi.fn(async () => "token-a"), isLoaded: true, isSignedIn: true, sessionId: "session-c" });
    rendered.rerender(<ProductionImplementationWorkspace view="plan" />);
    useAuth.mockReturnValue({ getToken: vi.fn(async () => "token-b"), isLoaded: true, isSignedIn: true, sessionId: "session-d" });
    rendered.rerender(<ProductionImplementationWorkspace view="plan" />);
    expect(await screen.findByDisplayValue("Session B content")).toBeInTheDocument();
    resolveOldList(json({ error: { code: "UNAUTHENTICATED", message: "Authentication required", correlationId: "40000000-0000-4000-8000-000000000001" } }, 401));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Member account unavailable" })).not.toBeInTheDocument());
  });

  it.each([
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
  ])("immediately evicts loaded content when a save returns %s", async (status, code) => {
    signedIn();
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/v1/member/artifacts") return json(list);
      if (init?.method === "POST") return json({ error: { code, message: "Hidden", correlationId: "40000000-0000-4000-8000-000000000001" } }, status);
      return json({ schemaVersion: 1, artifact: summaries[0], content: null });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ProductionImplementationWorkspace view="plan" />);
    fireEvent.change(await screen.findByLabelText("Notes"), { target: { value: "Must disappear" } });
    expect(await screen.findByRole("heading", { name: "Member account unavailable" }, { timeout: 2_000 })).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Must disappear")).not.toBeInTheDocument();
  });
});
