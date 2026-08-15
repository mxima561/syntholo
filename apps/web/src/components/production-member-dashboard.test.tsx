import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dashboardRequestVersion,
  ProductionMemberDashboard,
} from "./production-member-dashboard";

const useAuth = vi.hoisted(() => vi.fn());
vi.mock("@clerk/react", () => ({ useAuth }));

const accountId = "10000000-0000-4000-8000-000000000001";
const dashboard = {
  schemaVersion: 1,
  generatedAt: "2026-08-14T16:00:00.123Z",
  account: { id: accountId, name: "Acme Advisory" },
  access: {
    accountId,
    capabilities: {
      academy_course: true,
      support: false,
      circle_write: false,
      operator_club: false,
      business_os: false,
    },
    holds: [],
    seatLimit: 3,
    reservedSeats: 1,
    explanations: [
      { capability: "academy_course", sourceGrantIds: ["20000000-0000-4000-8000-000000000001"] },
      { capability: "support", sourceGrantIds: [] },
      { capability: "circle_write", sourceGrantIds: [] },
      { capability: "operator_club", sourceGrantIds: [] },
      { capability: "business_os", sourceGrantIds: [] },
    ],
  },
  experience: { state: "partial" },
  projections: {
    learning: { state: "unavailable", reason: "module_not_implemented" },
    support: { state: "unavailable", reason: "module_not_implemented" },
    sessions: { state: "unavailable", reason: "module_not_implemented" },
    implementation: { state: "unavailable", reason: "module_not_implemented" },
    recommendations: { state: "unavailable", reason: "module_not_implemented" },
  },
  nextBestStep: {
    kind: "unavailable",
    blockedBy: "support",
    reason: "module_not_implemented",
    target: "retry",
  },
} as const;
const courseId = "10000000-0000-4000-8000-000000000041";
const availableLessonId = "10000000-0000-4000-8000-000000000042";
const lockedLessonId = "10000000-0000-4000-8000-000000000043";
const dashboardV2 = {
  schemaVersion: 2,
  generatedAt: "2026-08-14T16:00:00.123Z",
  account: dashboard.account,
  access: dashboard.access,
  experience: { state: "ready" },
  learning: {
    state: "available",
    course: {
      schemaVersion: 1,
      enrollmentId: "10000000-0000-4000-8000-000000000044",
      course: {
        id: courseId,
        versionId: "10000000-0000-4000-8000-000000000045",
        title: "Syntholo Academy",
        description: "Build the operating system your growth needs.",
      },
      stages: [{
        id: "10000000-0000-4000-8000-000000000046",
        title: "Diagnose",
        order: 1,
        lessons: [{
          id: availableLessonId,
          lessonVersionId: "10000000-0000-4000-8000-000000000047",
          order: 1,
          required: true,
          title: "Map the constraint",
          summary: "Name the bottleneck before changing the system.",
          durationSeconds: 600,
          releaseRule: { kind: "immediate" },
          availability: "available",
          availableAt: "2026-08-14T16:00:00.000Z",
          progress: "not_started",
        }, {
          id: lockedLessonId,
          lessonVersionId: "10000000-0000-4000-8000-000000000048",
          order: 2,
          required: true,
          title: "Measure the system",
          summary: "Create the baseline your team can trust.",
          durationSeconds: 600,
          releaseRule: { kind: "elapsed_days", days: 7 },
          availability: "locked",
          availableAt: "2026-08-21T16:00:00.000Z",
          progress: "not_started",
        }],
      }],
      progress: { completedRequired: 0, requiredTotal: 18, percent: 0 },
    },
  },
  nextBestStep: {
    kind: "lesson",
    reason: "next_required_lesson",
    target: { courseId, lessonId: availableLessonId },
  },
} as const;
const dashboardV3 = {
  ...dashboardV2,
  schemaVersion: 3,
  implementation: {
    state: "available",
    artifacts: {
      schemaVersion: 1,
      items: ["readiness_map", "ai_policy", "workflow_portfolio", "enablement_checklist", "roadmap"]
        .map((kind, index) => ({
          id: `30000000-0000-4000-8000-00000000000${index + 1}`,
          kind,
          title: ["Readiness map", "AI policy", "Workflow portfolio", "Enablement checklist", "90-day roadmap"][index],
          currentVersion: index === 0 ? 1 : 0,
          currentState: index === 0 ? "draft" : null,
          currentVersionId: index === 0 ? "40000000-0000-4000-8000-000000000001" : null,
          updatedAt: index === 0 ? "2026-08-15T12:00:00.000Z" : null,
          authorLabel: index === 0 ? "You" : null,
        })),
      nextCursor: null,
      implementationCompletion: { completed: false, completedAt: null },
    },
  },
} as const;

function json(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  if (!headers.has("syntholo-dashboard-version")) {
    headers.set("syntholo-dashboard-version", "1");
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

function signedIn(fetcher: typeof fetch, getToken = vi.fn(async () => "clerk-token")) {
  useAuth.mockReturnValue({
    getToken,
    isLoaded: true,
    isSignedIn: true,
    sessionId: "session-one",
  });
  vi.stubGlobal("fetch", fetcher);
  return getToken;
}

afterEach(() => {
  useAuth.mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("ProductionMemberDashboard", () => {
  it("keeps v1 as the safe rollout default and accepts only explicit supported flags", () => {
    expect(dashboardRequestVersion()).toBe("1");
    vi.stubEnv("NEXT_PUBLIC_SYNTHOLO_DASHBOARD_VERSION", "invalid");
    expect(dashboardRequestVersion()).toBe("1");
    vi.stubEnv("NEXT_PUBLIC_SYNTHOLO_DASHBOARD_VERSION", "2");
    expect(dashboardRequestVersion()).toBe("2");
    vi.stubEnv("NEXT_PUBLIC_SYNTHOLO_DASHBOARD_VERSION", "3");
    expect(dashboardRequestVersion()).toBe("3");
  });

  it("dual-parses negotiated v3 and renders implementation progress without replacing the learning next step", async () => {
    vi.stubEnv("NEXT_PUBLIC_SYNTHOLO_DASHBOARD_VERSION", "3");
    const fetcher = vi.fn(async () => json(dashboardV3, {
      status: 200,
      headers: { "syntholo-dashboard-version": "3" },
    }));
    signedIn(fetcher);
    render(<ProductionMemberDashboard />);
    expect(await screen.findByRole("heading", { name: "Syntholo Academy" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Implementation workspace" })).toBeInTheDocument();
    expect(screen.getByText("1 of 5 artifacts started")).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith("/v1/member/dashboard", expect.objectContaining({
      headers: { authorization: "Bearer clerk-token", "syntholo-dashboard-version": "3" },
    }));
  });

  it("does not request while Clerk is loading or signed out", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    useAuth.mockReturnValue({ getToken: vi.fn(), isLoaded: false });
    const { rerender } = render(<ProductionMemberDashboard />);
    expect(screen.getByRole("status")).toHaveTextContent("Checking your Academy access");
    expect(fetcher).not.toHaveBeenCalled();

    useAuth.mockReturnValue({ getToken: vi.fn(), isLoaded: true, isSignedIn: false });
    rerender(<ProductionMemberDashboard />);
    expect(screen.getByRole("heading", { name: "Sign in to continue" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Member sign in" })).toHaveAttribute("href", "/sign-in");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requests exact v2 and renders the real course spine with locked lessons as nonlinks", async () => {
    vi.stubEnv("NEXT_PUBLIC_SYNTHOLO_DASHBOARD_VERSION", "2");
    const fetcher = vi.fn(async () => json(dashboardV2, {
      status: 200,
      headers: { "syntholo-dashboard-version": "2" },
    }));
    const getToken = signedIn(fetcher);
    render(<ProductionMemberDashboard />);

    expect(await screen.findByRole("heading", { name: "Acme Advisory" })).toBeInTheDocument();
    expect(screen.getByText(/1 of 3 seats reserved/u)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Syntholo Academy" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Map the constraint/u })).toHaveAttribute(
      "href",
      `/learn/course/${availableLessonId}`,
    );
    expect(screen.queryByRole("link", { name: /Measure the system/u })).not.toBeInTheDocument();
    expect(screen.getByText(/Available Aug 21/u)).toBeInTheDocument();
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/v1/member/dashboard", expect.objectContaining({
      cache: "no-store",
      credentials: "omit",
      headers: {
        authorization: "Bearer clerk-token",
        "syntholo-dashboard-version": "2",
      },
      signal: expect.any(AbortSignal),
    }));
    expect(document.body).not.toHaveTextContent(/Maria|Northstar|Naomi|coach online|progress/iu);
  });

  it("dual-parses an explicit v1 response during the negotiated rollout", async () => {
    signedIn(vi.fn(async () => json(dashboard, { status: 200 })));
    render(<ProductionMemberDashboard />);
    expect(await screen.findByRole("heading", { name: "Dashboard data is still coming online" }))
      .toBeInTheDocument();
  });

  it("renders access-required, no-enrollment, and ready as distinct honest states", async () => {
    const accessRequired = {
      ...dashboard,
      access: {
        ...dashboard.access,
        capabilities: { ...dashboard.access.capabilities, academy_course: false },
        explanations: dashboard.access.explanations.map((value) => value.capability === "academy_course"
          ? { ...value, sourceGrantIds: [] }
          : value),
      },
      experience: { state: "access_required" },
      nextBestStep: { kind: "access_blocker", reason: "academy_course_required", target: "program_options" },
    };
    signedIn(vi.fn(async () => json(accessRequired)));
    const { unmount } = render(<ProductionMemberDashboard />);
    expect(await screen.findByRole("heading", { name: "Academy access required" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View program options" })).toHaveAttribute("href", "/pricing");
    unmount();

    const noEnrollment = {
      ...dashboard,
      experience: { state: "no_enrollment" },
      projections: { ...dashboard.projections, learning: { state: "empty", reason: "no_enrollment" } },
      nextBestStep: { kind: "enrollment_blocker", reason: "academy_enrollment_missing", target: "retry" },
    };
    signedIn(vi.fn(async () => json(noEnrollment)));
    const second = render(<ProductionMemberDashboard />);
    expect(await screen.findByRole("heading", { name: "Academy setup is not complete" })).toBeInTheDocument();
    second.unmount();

    const ready = {
      ...dashboard,
      experience: { state: "ready" },
      projections: {
        learning: { state: "empty", reason: "no_required_lesson" },
        support: { state: "empty", reason: "no_customer_response_due" },
        sessions: { state: "empty", reason: "no_session_within_48_hours" },
        implementation: { state: "empty", reason: "no_incomplete_artifact_or_feedback" },
        recommendations: { state: "empty", reason: "no_optional_recommendation" },
      },
      nextBestStep: { kind: "none", reason: "no_action_available", target: null },
    };
    signedIn(vi.fn(async () => json(ready)));
    render(<ProductionMemberDashboard />);
    expect(await screen.findByRole("heading", { name: "No action is currently available" })).toBeInTheDocument();
  });

  it("uses non-assertive account-unavailable copy for a valid collapsed 401", async () => {
    const correlationId = "40000000-0000-4000-8000-000000000001";
    signedIn(vi.fn(async () => json({
      error: { code: "UNAUTHENTICATED", message: "Authentication required", correlationId },
    }, { status: 401, headers: { "x-correlation-id": correlationId } })));
    render(<ProductionMemberDashboard />);
    expect(await screen.findByRole("heading", { name: "Member account unavailable" })).toBeInTheDocument();
    expect(screen.getByText(/could not connect this sign-in to an active Syntholo member account/iu))
      .toBeInTheDocument();
  });

  it("renders a correlated degraded state for 503 and retries with a fresh token", async () => {
    vi.stubEnv("NEXT_PUBLIC_SYNTHOLO_DASHBOARD_VERSION", "2");
    const correlationId = "40000000-0000-4000-8000-000000000002";
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({
        error: { code: "DEPENDENCY_UNAVAILABLE", message: "Service temporarily unavailable", correlationId },
      }, { status: 503, headers: { "x-correlation-id": correlationId } }))
      .mockResolvedValueOnce(json(dashboardV2, {
        status: 200,
        headers: { "syntholo-dashboard-version": "2" },
      }));
    const getToken = signedIn(fetcher, vi.fn()
      .mockResolvedValueOnce("first-token")
      .mockResolvedValueOnce("second-token"));
    render(<ProductionMemberDashboard />);
    expect(await screen.findByRole("heading", { name: "Dashboard temporarily unavailable" }))
      .toBeInTheDocument();
    expect(screen.getByText(new RegExp(correlationId, "u"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Acme Advisory" })).toBeInTheDocument();
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it.each([
    [json(dashboard, { headers: { "syntholo-dashboard-version": "2" } }), "version mismatch"],
    [json(dashboardV2, { headers: { "syntholo-dashboard-version": "1" } }), "reverse version mismatch"],
    [new Response("not json", { status: 200, headers: { "content-type": "application/json", "syntholo-dashboard-version": "1" } }), "invalid JSON"],
    [json({ ...dashboard, account: { ...dashboard.account, id: "10000000-0000-4000-8000-000000000002" } }), "invariant mismatch"],
    [new Response(JSON.stringify(dashboard), { status: 200, headers: { "content-type": "text/plain", "syntholo-dashboard-version": "1" } }), "non-JSON"],
  ])("fails closed for %s", async (response) => {
    signedIn(vi.fn(async () => response));
    render(<ProductionMemberDashboard />);
    expect(await screen.findByRole("heading", { name: "Dashboard temporarily unavailable" }))
      .toBeInTheDocument();
    expect(screen.queryByText("Acme Advisory")).not.toBeInTheDocument();
  });

  it("does not silently retry a 406 under another version", async () => {
    const correlationId = "40000000-0000-4000-8000-000000000003";
    const fetcher = vi.fn(async () => json({
      error: { code: "NOT_ACCEPTABLE", message: "Unavailable", correlationId },
    }, { status: 406, headers: { "x-correlation-id": correlationId } }));
    signedIn(fetcher);
    render(<ProductionMemberDashboard />);
    expect(await screen.findByRole("heading", { name: "Dashboard temporarily unavailable" }))
      .toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("ignores an in-flight prior-session result after the session changes", async () => {
    vi.stubEnv("NEXT_PUBLIC_SYNTHOLO_DASHBOARD_VERSION", "2");
    let resolveFirst!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const fetcher = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(json({
        ...dashboardV2,
        account: { ...dashboardV2.account, name: "Second Account" },
      }, { headers: { "syntholo-dashboard-version": "2" } }));
    const auth = {
      getToken: vi.fn(async () => "token"),
      isLoaded: true,
      isSignedIn: true,
      sessionId: "session-one",
    };
    useAuth.mockReturnValue(auth);
    vi.stubGlobal("fetch", fetcher);
    const { rerender } = render(<ProductionMemberDashboard />);
    useAuth.mockReturnValue({ ...auth, sessionId: "session-two" });
    rerender(<ProductionMemberDashboard />);
    expect(await screen.findByRole("heading", { name: "Second Account" })).toBeInTheDocument();
    resolveFirst(json(dashboardV2, { headers: { "syntholo-dashboard-version": "2" } }));
    await waitFor(() => expect(screen.queryByText("Acme Advisory")).not.toBeInTheDocument());
  });
});
