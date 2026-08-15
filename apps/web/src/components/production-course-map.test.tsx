import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionCourseMap } from "./production-course-map";

const useAuth = vi.hoisted(() => vi.fn());
vi.mock("@clerk/react", () => ({ useAuth }));

const accountId = "10000000-0000-4000-8000-000000000001";
const courseId = "10000000-0000-4000-8000-000000000041";
const response = {
  schemaVersion: 2,
  generatedAt: "2026-08-15T12:00:00.000Z",
  account: { id: accountId, name: "Acme Advisory" },
  access: {
    accountId,
    capabilities: { academy_course: true, support: false, circle_write: false, operator_club: false, business_os: false },
    holds: [], seatLimit: 3, reservedSeats: 1,
    explanations: [
      { capability: "academy_course", sourceGrantIds: ["20000000-0000-4000-8000-000000000001"] },
      { capability: "support", sourceGrantIds: [] },
      { capability: "circle_write", sourceGrantIds: [] },
      { capability: "operator_club", sourceGrantIds: [] },
      { capability: "business_os", sourceGrantIds: [] },
    ],
  },
  experience: { state: "ready" },
  learning: {
    state: "available",
    course: {
      schemaVersion: 1,
      enrollmentId: "10000000-0000-4000-8000-000000000042",
      course: { id: courseId, versionId: "10000000-0000-4000-8000-000000000043", title: "Syntholo Academy", description: "Implementation course" },
      stages: [],
      progress: { completedRequired: 0, requiredTotal: 18, percent: 0 },
    },
  },
  nextBestStep: { kind: "course", reason: "required_lesson_locked", target: { courseId } },
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  useAuth.mockReset();
});

describe("ProductionCourseMap", () => {
  it("loads only the negotiated actor-owned v2 course and never a demo fixture", async () => {
    vi.stubEnv("NEXT_PUBLIC_SYNTHOLO_DASHBOARD_VERSION", "2");
    useAuth.mockReturnValue({
      getToken: vi.fn(async () => "clerk-token"),
      isLoaded: true,
      isSignedIn: true,
      sessionId: "session-one",
    });
    const fetcher = vi.fn(async () => new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "syntholo-dashboard-version": "2",
      },
    }));
    vi.stubGlobal("fetch", fetcher);

    render(<ProductionCourseMap />);

    expect(await screen.findByRole("heading", { name: "Syntholo Academy" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open the full course map" })).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith("/v1/member/dashboard", expect.objectContaining({
      headers: { authorization: "Bearer clerk-token", "syntholo-dashboard-version": "2" },
    }));
    expect(document.body).not.toHaveTextContent(/Maria|Northstar|Naomi/u);
  });

  it("never renders a prior session course after the Clerk session changes", async () => {
    vi.stubEnv("NEXT_PUBLIC_SYNTHOLO_DASHBOARD_VERSION", "2");
    let resolveFirst!: (value: Response) => void;
    const first = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const secondBody = {
      ...response,
      account: { ...response.account, name: "Second Account" },
      learning: {
        ...response.learning,
        course: {
          ...response.learning.course,
          course: { ...response.learning.course.course, title: "Second Course" },
        },
      },
    };
    const fetcher = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(new Response(JSON.stringify(secondBody), {
        status: 200,
        headers: { "content-type": "application/json", "syntholo-dashboard-version": "2" },
      }));
    const auth = { getToken: vi.fn(async () => "token"), isLoaded: true, isSignedIn: true, sessionId: "session-a" };
    useAuth.mockReturnValue(auth);
    vi.stubGlobal("fetch", fetcher);
    const { rerender } = render(<ProductionCourseMap />);
    useAuth.mockReturnValue({ ...auth, sessionId: "session-b" });
    rerender(<ProductionCourseMap />);

    expect(await screen.findByRole("heading", { name: "Second Course" })).toBeInTheDocument();
    resolveFirst(new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json", "syntholo-dashboard-version": "2" },
    }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Syntholo Academy" })).not.toBeInTheDocument());
  });

  it("removes an already-resolved account course on the first render of a new session", async () => {
    vi.stubEnv("NEXT_PUBLIC_SYNTHOLO_DASHBOARD_VERSION", "2");
    let resolveSecond!: (value: Response) => void;
    const second = new Promise<Response>((resolve) => { resolveSecond = resolve; });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json", "syntholo-dashboard-version": "2" },
      }))
      .mockReturnValueOnce(second);
    const auth = { getToken: vi.fn(async () => "token"), isLoaded: true, isSignedIn: true, sessionId: "session-a" };
    useAuth.mockReturnValue(auth);
    vi.stubGlobal("fetch", fetcher);
    const { rerender } = render(<ProductionCourseMap />);
    expect(await screen.findByRole("heading", { name: "Syntholo Academy" })).toBeInTheDocument();

    useAuth.mockReturnValue({ ...auth, sessionId: "session-b" });
    rerender(<ProductionCourseMap />);
    expect(screen.queryByRole("heading", { name: "Syntholo Academy" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading your course");

    resolveSecond(new Response(JSON.stringify({ ...response, learning: { ...response.learning, course: { ...response.learning.course, course: { ...response.learning.course.course, title: "Session B Academy" } } } }), {
      status: 200,
      headers: { "content-type": "application/json", "syntholo-dashboard-version": "2" },
    }));
    expect(await screen.findByRole("heading", { name: "Session B Academy" })).toBeInTheDocument();
  });
});
