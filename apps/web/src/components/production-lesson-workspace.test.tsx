import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductionLessonWorkspace } from "./production-lesson-workspace";

const useAuth = vi.hoisted(() => vi.fn());
vi.mock("@clerk/react", () => ({ useAuth }));
vi.mock("@mux/mux-player-react/lazy", async () => {
  const React = await import("react");
  const MockMuxPlayer = React.forwardRef<HTMLVideoElement, Record<string, unknown>>((props, ref) => {
      const tokens = props.tokens as { playback?: string } | undefined;
      return (
        <video
          aria-label={String(props["aria-label"])}
          controls
          data-playback-id={String(props.playbackId)}
          data-playback-token={tokens?.playback}
          onLoadedMetadata={props.onLoadedMetadata as React.ReactEventHandler<HTMLVideoElement>}
          onPause={props.onPause as React.ReactEventHandler<HTMLVideoElement>}
          onPlay={props.onPlay as React.ReactEventHandler<HTMLVideoElement>}
          onTimeUpdate={props.onTimeUpdate as React.ReactEventHandler<HTMLVideoElement>}
          ref={ref}
        />
      );
    });
  MockMuxPlayer.displayName = "MockMuxPlayer";
  return { default: MockMuxPlayer };
});

const lessonId = "10000000-0000-4000-8000-000000000041";
const lessonVersionId = "10000000-0000-4000-8000-000000000042";
const lesson = {
  schemaVersion: 1,
  enrollmentId: "10000000-0000-4000-8000-000000000043",
  courseVersionId: "10000000-0000-4000-8000-000000000044",
  lessonId,
  lessonVersionId,
  title: "Map the constraint",
  summary: "Name the bottleneck before changing the system.",
  durationSeconds: 600,
  blocks: [{
    type: "action",
    blockId: "action-1",
    title: "Write the constraint statement",
    instructions: "Name the system, the bottleneck, and the evidence.",
  }],
  transcript: {
    schemaVersion: 1,
    blocks: [
      { blockId: "transcript-1", text: "Start with the customer promise." },
      { blockId: "transcript-2", text: "Then trace the work backwards." },
    ],
  },
  resources: [{
    id: "10000000-0000-4000-8000-000000000045",
    label: "Constraint worksheet",
    accessibleLabel: "Download the constraint worksheet",
    delivery: "private_blob",
    mime: "application/pdf",
    byteSize: 2048,
    availability: "unavailable",
  }],
  progress: { revision: null, state: "not_started", lastPath: null, position: null },
  previousRequiredLessonId: null,
  nextRequiredLessonId: "10000000-0000-4000-8000-000000000046",
} as const;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function signedIn(fetcher: typeof fetch) {
  useAuth.mockReturnValue({
    getToken: vi.fn(async () => "clerk-token"),
    isLoaded: true,
    isSignedIn: true,
    sessionId: "session-one",
  });
  vi.stubGlobal("fetch", fetcher);
}

afterEach(() => {
  useAuth.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
});

describe("ProductionLessonWorkspace", () => {
  it("keeps a degraded video lesson usable through transcript, action, resources, resume, and completion", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/playback")) return response({
        schemaVersion: 1,
        lessonVersionId,
        playbackStatus: "degraded",
        reason: "MUX_UNAVAILABLE",
        fallback: {
          title: lesson.title,
          summary: lesson.summary,
          blocks: lesson.blocks,
          transcript: lesson.transcript,
          resources: lesson.resources,
        },
      });
      if (path.endsWith("/resume") && init?.method === "PUT") return response({
        revision: 1,
        state: "in_progress",
        lastPath: "transcript",
        position: { blockId: "transcript-2" },
      });
      if (path.endsWith("/complete") && init?.method === "POST") return response({
        schemaVersion: 1,
        lessonCompletion: {
          id: "10000000-0000-4000-8000-000000000047",
          lessonVersionId,
          method: "transcript",
          completedAt: "2026-08-15T12:00:00.000Z",
        },
        courseCompletion: null,
        nextRequiredLessonId: lesson.nextRequiredLessonId,
      });
      return response(lesson);
    });
    signedIn(fetcher);
    render(<ProductionLessonWorkspace lessonId={lessonId} />);

    expect(await screen.findByRole("heading", { name: lesson.title })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/video is unavailable/i);
    expect(screen.getByRole("tab", { name: "Transcript" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Start with the customer promise.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /save position at then trace/i }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      `/v1/member/lessons/${lessonId}/resume`,
      expect.objectContaining({ method: "PUT" }),
    ));
    expect(screen.getByText("Constraint worksheet")).toBeInTheDocument();
    expect(screen.getByText(/PDF · 2 KB/u)).toBeInTheDocument();
    expect(screen.getByText("Download unavailable in this release")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("Delivery coming soon");
    await user.click(screen.getByRole("button", { name: "Mark lesson complete" }));
    expect(await screen.findByRole("heading", { name: "Lesson completed" })).toBeInTheDocument();
    const completeCall = fetcher.mock.calls.find(([url]) => String(url).endsWith("/complete"));
    expect(completeCall?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ "idempotency-key": expect.stringMatching(/^lesson-complete-/u) }),
    });
  });

  it("renders an actual signed Mux video without autoplay and restores video resume", async () => {
    const resumedLesson = {
      ...lesson,
      progress: { revision: 3, state: "in_progress", lastPath: "video", position: { seconds: 120 } },
    };
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith("/playback")
      ? response({
          schemaVersion: 1,
          lessonVersionId,
          playbackStatus: "ready",
          mux: {
            playbackId: "signed-playback-id",
            playbackToken: "signed-playback-token",
            issuedAt: "2026-08-15T12:00:00.000Z",
            refreshAfter: "2026-08-15T12:04:00.000Z",
            expiresAt: "2026-08-15T12:14:00.000Z",
          },
        })
      : response(resumedLesson));
    signedIn(fetcher);
    render(<ProductionLessonWorkspace lessonId={lessonId} />);

    const video = await screen.findByLabelText(`Video: ${lesson.title}`);
    expect(video).toHaveAttribute("controls");
    expect(video).not.toHaveAttribute("autoplay");
    expect(video).toHaveAttribute("data-playback-id", "signed-playback-id");
    expect(video).toHaveAttribute("data-playback-token", "signed-playback-token");
    fireEvent.loadedMetadata(video);
    expect((video as HTMLVideoElement).currentTime).toBe(120);
    expect(document.body).not.toHaveTextContent("signed-playback-token");
  });

  it("renders a locked visit with its authoritative date and no lesson controls", async () => {
    const availableAt = "2026-08-22T12:00:00.000Z";
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith("/playback")
      ? response({ schemaVersion: 1, lessonVersionId, playbackStatus: "degraded", reason: "MEDIA_NOT_READY", fallback: { title: lesson.title, summary: lesson.summary, blocks: lesson.blocks, transcript: lesson.transcript, resources: lesson.resources } })
      : response({ error: { code: "LESSON_NOT_RELEASED", message: "Lesson not released", correlationId: "40000000-0000-4000-8000-000000000001", details: { availableAt } } }, 403));
    signedIn(fetcher);
    render(<ProductionLessonWorkspace lessonId={lessonId} />);

    expect(await screen.findByRole("heading", { name: "This lesson is not released yet" })).toBeInTheDocument();
    expect(screen.getByText(/Aug 22, 2026/u)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to course map" })).toHaveAttribute("href", "/learn/course");
    expect(screen.queryByRole("button", { name: "Mark lesson complete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Transcript" })).not.toBeInTheDocument();
  });

  it("removes resolved lesson content immediately when a reused route changes lesson id", async () => {
    const secondLessonId = "10000000-0000-4000-8000-000000000051";
    const secondVersionId = "10000000-0000-4000-8000-000000000052";
    let resolveSecondLesson!: (value: Response) => void;
    let resolveSecondPlayback!: (value: Response) => void;
    const secondLesson = new Promise<Response>((resolve) => { resolveSecondLesson = resolve; });
    const secondPlayback = new Promise<Response>((resolve) => { resolveSecondPlayback = resolve; });
    const fetcher = vi.fn((url: string | URL | Request) => {
      const path = String(url);
      if (path.includes(secondLessonId)) return path.endsWith("/playback") ? secondPlayback : secondLesson;
      return Promise.resolve(path.endsWith("/playback")
        ? response({ schemaVersion: 1, lessonVersionId, playbackStatus: "degraded", reason: "MUX_UNAVAILABLE", fallback: { title: lesson.title, summary: lesson.summary, blocks: lesson.blocks, transcript: lesson.transcript, resources: lesson.resources } })
        : response(lesson));
    });
    signedIn(fetcher as typeof fetch);
    const { rerender } = render(<ProductionLessonWorkspace lessonId={lessonId} />);
    expect(await screen.findByRole("heading", { name: lesson.title })).toBeInTheDocument();

    rerender(<ProductionLessonWorkspace lessonId={secondLessonId} />);
    expect(screen.queryByRole("heading", { name: lesson.title })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Checking your Academy access");
    resolveSecondLesson(response({ ...lesson, lessonId: secondLessonId, lessonVersionId: secondVersionId, title: "Second lesson" }));
    resolveSecondPlayback(response({ schemaVersion: 1, lessonVersionId: secondVersionId, playbackStatus: "degraded", reason: "MUX_UNAVAILABLE", fallback: { title: "Second lesson", summary: lesson.summary, blocks: lesson.blocks, transcript: lesson.transcript, resources: lesson.resources } }));
    expect(await screen.findByRole("heading", { name: "Second lesson" })).toBeInTheDocument();
  });

  it("ignores late lesson and token responses from a replaced Clerk session", async () => {
    const lessonB = { ...lesson, title: "Session B lesson" };
    let resolveLessonA!: (value: Response) => void;
    let resolvePlaybackA!: (value: Response) => void;
    const pendingLessonA = new Promise<Response>((resolve) => { resolveLessonA = resolve; });
    const pendingPlaybackA = new Promise<Response>((resolve) => { resolvePlaybackA = resolve; });
    const fetcher = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const isA = new Headers(init?.headers).get("authorization") === "Bearer token-a";
      if (isA) return String(url).endsWith("/playback") ? pendingPlaybackA : pendingLessonA;
      return Promise.resolve(String(url).endsWith("/playback")
        ? response({ schemaVersion: 1, lessonVersionId, playbackStatus: "degraded", reason: "MUX_UNAVAILABLE", fallback: { title: lessonB.title, summary: lessonB.summary, blocks: lessonB.blocks, transcript: lessonB.transcript, resources: lessonB.resources } })
        : response(lessonB));
    });
    const authA = { getToken: vi.fn(async () => "token-a"), isLoaded: true, isSignedIn: true, sessionId: "session-a" };
    useAuth.mockReturnValue(authA);
    vi.stubGlobal("fetch", fetcher);
    const { rerender } = render(<ProductionLessonWorkspace lessonId={lessonId} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

    useAuth.mockReturnValue({ ...authA, getToken: vi.fn(async () => "token-b"), sessionId: "session-b" });
    rerender(<ProductionLessonWorkspace lessonId={lessonId} />);
    expect(await screen.findByRole("heading", { name: lessonB.title })).toBeInTheDocument();
    resolveLessonA(response(lesson));
    resolvePlaybackA(response({ schemaVersion: 1, lessonVersionId, playbackStatus: "ready", mux: { playbackId: "old-playback", playbackToken: "old-token", issuedAt: "2026-08-15T12:00:00.000Z", refreshAfter: "2026-08-15T12:04:00.000Z", expiresAt: "2026-08-15T12:14:00.000Z" } }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: lesson.title })).not.toBeInTheDocument());
    expect(screen.queryByLabelText(`Video: ${lesson.title}`)).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("old-token");
  });

  it("preserves an exact failed resume intent and retries it unchanged", async () => {
    const user = userEvent.setup();
    const resumeBodies: string[] = [];
    let resumeAttempts = 0;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/playback")) return response({ schemaVersion: 1, lessonVersionId, playbackStatus: "degraded", reason: "MUX_UNAVAILABLE", fallback: { title: lesson.title, summary: lesson.summary, blocks: lesson.blocks, transcript: lesson.transcript, resources: lesson.resources } });
      if (path.endsWith("/resume")) {
        resumeBodies.push(String(init?.body));
        resumeAttempts += 1;
        return resumeAttempts === 1 ? response({ error: { code: "DEPENDENCY_UNAVAILABLE" } }, 503) : response({ revision: 1, state: "in_progress", lastPath: "transcript", position: { blockId: "transcript-2" } });
      }
      return response(lesson);
    });
    signedIn(fetcher);
    render(<ProductionLessonWorkspace lessonId={lessonId} />);
    await screen.findByRole("heading", { name: lesson.title });
    await user.click(screen.getByRole("button", { name: /save position at then trace/i }));
    expect(await screen.findByText("Progress not saved.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(resumeBodies).toHaveLength(2));
    expect(resumeBodies[1]).toBe(resumeBodies[0]);
    expect(JSON.parse(resumeBodies[0] ?? "{}")).toEqual({ expectedVersion: 0, path: "transcript", position: { blockId: "transcript-2" } });
  });

  it("reuses a completion key on retry, reports mixed use, trusts the response next lesson, and rotates for a new lesson", async () => {
    const user = userEvent.setup();
    const completionCalls: Array<{ body: string; key: string }> = [];
    let firstLessonAttempts = 0;
    const secondLessonId = "10000000-0000-4000-8000-000000000061";
    const secondVersionId = "10000000-0000-4000-8000-000000000062";
    const authoritativeNext = "10000000-0000-4000-8000-000000000063";
    const resumed = { ...lesson, progress: { revision: 2, state: "in_progress", lastPath: "video", position: { seconds: 42 } } };
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      const second = path.includes(secondLessonId);
      const version = second ? secondVersionId : lessonVersionId;
      if (path.endsWith("/playback")) return response({ schemaVersion: 1, lessonVersionId: version, playbackStatus: "degraded", reason: "MUX_UNAVAILABLE", fallback: { title: second ? "Second lesson" : lesson.title, summary: lesson.summary, blocks: lesson.blocks, transcript: lesson.transcript, resources: lesson.resources } });
      if (path.endsWith("/complete")) {
        const key = new Headers(init?.headers).get("idempotency-key") ?? "";
        completionCalls.push({ body: String(init?.body), key });
        if (!second && firstLessonAttempts++ === 0) return response({ error: { code: "DEPENDENCY_UNAVAILABLE" } }, 503);
        return response({ schemaVersion: 1, lessonCompletion: { id: second ? "10000000-0000-4000-8000-000000000064" : "10000000-0000-4000-8000-000000000047", lessonVersionId: version, method: second ? "transcript" : "mixed", completedAt: "2026-08-15T12:00:00.000Z" }, courseCompletion: null, nextRequiredLessonId: second ? null : authoritativeNext });
      }
      return response(second ? { ...lesson, lessonId: secondLessonId, lessonVersionId: secondVersionId, title: "Second lesson" } : resumed);
    });
    signedIn(fetcher);
    const { rerender } = render(<ProductionLessonWorkspace lessonId={lessonId} />);
    await screen.findByRole("heading", { name: lesson.title });
    await user.click(screen.getByRole("button", { name: "Mark lesson complete" }));
    expect(await screen.findByText("Completion not recorded. Retry when ready.")).toBeInTheDocument();
    const retryButton = screen.getByRole("button", { name: "Retry completion" });
    expect(retryButton).toHaveFocus();
    await user.click(retryButton);
    expect(await screen.findByRole("heading", { name: "Lesson completed" })).toBeInTheDocument();
    expect(completionCalls[1]?.key).toBe(completionCalls[0]?.key);
    expect(JSON.parse(completionCalls[0]?.body ?? "{}")).toEqual({ method: "mixed" });
    expect(screen.getByRole("link", { name: "Next lesson" })).toHaveAttribute("href", `/learn/course/${authoritativeNext}`);

    rerender(<ProductionLessonWorkspace lessonId={secondLessonId} />);
    await screen.findByRole("heading", { name: "Second lesson" });
    await user.click(screen.getByRole("button", { name: "Mark lesson complete" }));
    await waitFor(() => expect(completionCalls).toHaveLength(3));
    expect(completionCalls[2]?.key).not.toBe(completionCalls[0]?.key);
  });

  it("restores transcript position without focus theft and ignores a non-dirty pause", async () => {
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      const resumed = { ...lesson, progress: { revision: 4, state: "in_progress", lastPath: "transcript", position: { blockId: "transcript-2" } } };
      const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith("/playback")
        ? response({ schemaVersion: 1, lessonVersionId, playbackStatus: "ready", mux: { playbackId: "playback", playbackToken: "token", issuedAt: "2026-08-15T12:00:00.000Z", refreshAfter: "2026-08-15T12:04:00.000Z", expiresAt: "2026-08-15T12:14:00.000Z" } })
        : response(resumed));
      signedIn(fetcher);
      render(<ProductionLessonWorkspace lessonId={lessonId} />);
      const video = await screen.findByLabelText(`Video: ${lesson.title}`);
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
      expect(document.activeElement).not.toBe(document.getElementById("transcript-transcript-2"));
      fireEvent.pause(video);
      expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/resume"))).toBe(false);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("stops and removes playback on auth loss but retains transcript on a typed dependency refresh failure", async () => {
    const user = userEvent.setup();
    const ready = { schemaVersion: 1, lessonVersionId, playbackStatus: "ready", mux: { playbackId: "playback", playbackToken: "token", issuedAt: "2026-08-15T12:00:00.000Z", refreshAfter: "2020-08-15T12:00:00.000Z", expiresAt: "2030-08-15T12:14:00.000Z" } } as const;
    let playbackCalls = 0;
    const authLoss = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/playback")) return ++playbackCalls === 1 ? response(ready) : response({ error: { code: "COURSE_ACCESS_REQUIRED" } }, 403);
      return response(lesson);
    });
    signedIn(authLoss);
    const first = render(<ProductionLessonWorkspace lessonId={lessonId} />);
    const video = await screen.findByLabelText(`Video: ${lesson.title}`);
    fireEvent.play(video);
    expect(await screen.findByRole("heading", { name: "Access could not be reconfirmed" })).toBeInTheDocument();
    expect(screen.queryByLabelText(`Video: ${lesson.title}`)).not.toBeInTheDocument();
    first.unmount();

    playbackCalls = 0;
    const dependency = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/playback")) return ++playbackCalls === 1 ? response(ready) : response({ error: { code: "DEPENDENCY_UNAVAILABLE" } }, 503);
      return response(lesson);
    });
    signedIn(dependency);
    render(<ProductionLessonWorkspace lessonId={lessonId} />);
    const secondVideo = await screen.findByLabelText(`Video: ${lesson.title}`);
    fireEvent.play(secondVideo);
    expect(await screen.findByText("Video is unavailable right now")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue with transcript" }));
    expect(screen.getByText("Start with the customer promise.")).toBeInTheDocument();
  });
});
