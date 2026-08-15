"use client";

import { useAuth } from "@clerk/react";
import {
  MemberDashboardResponseSchema,
  MemberDashboardV2ResponseSchema,
  type MemberDashboardV2Response,
  type MemberDashboardWireResponse,
} from "@syntholo/contracts/member-dashboard";
import { ApiErrorSchema } from "@syntholo/contracts/http";
import Link from "next/link";
import { useEffect, useState } from "react";
import { createMemberApiClient } from "@/lib/api/client";
import { Progress } from "@/components/ui/progress";

type Resolution = Readonly<
  | { sessionId: string; state: "account_unavailable" }
  | { sessionId: string; state: "degraded"; correlationId?: string }
  | { sessionId: string; state: "resolved"; dashboard: MemberDashboardWireResponse }
>;

function StatePage({
  heading,
  message,
  children,
  live = false,
}: Readonly<{
  heading: string;
  message: string;
  children?: React.ReactNode;
  live?: boolean;
}>) {
  return (
    <main className="state-page" {...(live ? { role: "status" } : {})}>
      <span className="brand-mark">S</span>
      <span className="micro-label">Member dashboard</span>
      <h1>{heading}</h1>
      <p>{message}</p>
      {children}
    </main>
  );
}

async function parseApiError(response: Response): Promise<{
  code: string;
  correlationId: string;
} | null> {
  if (!/^application\/json(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) {
    return null;
  }
  try {
    const parsed = ApiErrorSchema.safeParse(await response.json());
    const headerCorrelation = response.headers.get("x-correlation-id");
    if (
      !parsed.success
      || headerCorrelation === null
      || headerCorrelation !== parsed.data.error.correlationId
    ) return null;
    return {
      code: parsed.data.error.code,
      correlationId: parsed.data.error.correlationId,
    };
  } catch {
    return null;
  }
}

export async function parseMemberDashboardResponse(
  response: Response,
  requestedVersion: "1" | "2",
): Promise<MemberDashboardWireResponse> {
  if (
    !response.ok
    || !/^application\/json(?:;|$)/iu.test(response.headers.get("content-type") ?? "")
  ) throw new Error("MEMBER_DASHBOARD_RESPONSE_INVALID");
  const version = response.headers.get("syntholo-dashboard-version");
  if (version !== requestedVersion) throw new Error("MEMBER_DASHBOARD_RESPONSE_INVALID");
  const payload: unknown = await response.json();
  if (version === "2") {
    const parsed = MemberDashboardV2ResponseSchema.safeParse(payload);
    if (parsed.success) return parsed.data;
  } else if (version === "1") {
    const parsed = MemberDashboardResponseSchema.safeParse(payload);
    if (parsed.success) return parsed.data;
  }
  throw new Error("MEMBER_DASHBOARD_RESPONSE_INVALID");
}

export function dashboardRequestVersion(): "1" | "2" {
  return process.env.NEXT_PUBLIC_SYNTHOLO_DASHBOARD_VERSION === "2" ? "2" : "1";
}

function RetryButton({ onRetry }: Readonly<{ onRetry(): void }>) {
  return (
    <button className="button button-primary button-medium" onClick={onRetry} type="button">
      Try again
    </button>
  );
}

function availableLabel(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

export function ProductionCourseSpine({ dashboard, showOpenCourseLink = true }: Readonly<{
  dashboard: MemberDashboardV2Response;
  showOpenCourseLink?: boolean;
}>) {
  if (dashboard.learning.state !== "available") return null;
  const course = dashboard.learning.course;
  const nextLessonId = dashboard.nextBestStep.kind === "lesson"
    ? dashboard.nextBestStep.target.lessonId
    : null;
  return (
    <section aria-labelledby="academy-course-title" className="production-course-spine">
      <div className="production-course-summary">
        <div>
          <span className="micro-label">Implementation course</span>
          <h2 id="academy-course-title">{course.course.title}</h2>
          <p>{course.course.description}</p>
        </div>
        <div className="production-course-progress">
          <strong>{course.progress.percent}%</strong>
          <span>{course.progress.completedRequired} / {course.progress.requiredTotal} required</span>
          <Progress
            label={`${course.progress.completedRequired} of ${course.progress.requiredTotal} required lessons complete`}
            value={course.progress.percent}
          />
        </div>
      </div>
      <ol aria-label="Academy implementation stages" className="production-stage-spine">
        {course.stages.map((stage) => (
          <li className="production-stage" key={stage.id}>
            <div className="production-stage-heading">
              <span>Stage {String(stage.order).padStart(2, "0")}</span>
              <h3>{stage.title}</h3>
            </div>
            <ol className="production-stage-lessons">
              {stage.lessons.map((lesson) => {
                const label = (
                  <>
                    <span aria-hidden="true" className={`production-lesson-marker is-${lesson.progress}`} />
                    <span className="production-lesson-copy">
                      <strong>{lesson.title}</strong>
                      <span>{lesson.summary}</span>
                    </span>
                    <span className="production-lesson-meta">
                      <span>{lesson.progress === "completed" ? "Completed" : lesson.progress === "in_progress" ? "In progress" : "Not started"}</span>
                      <span>{lesson.availability === "available"
                        ? `${Math.ceil(lesson.durationSeconds / 60)} min`
                        : `Available ${availableLabel(lesson.availableAt)}`}</span>
                    </span>
                  </>
                );
                return (
                  <li key={lesson.id}>
                    {lesson.availability === "available" ? (
                      <Link
                        {...(lesson.id === nextLessonId ? { "aria-current": "step" } : {})}
                        className="production-lesson-row"
                        href={`/learn/course/${lesson.id}`}
                      >
                        {label}
                      </Link>
                    ) : (
                      <div aria-disabled="true" className="production-lesson-row is-locked">
                        {label}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </li>
        ))}
      </ol>
      {showOpenCourseLink ? (
        <Link className="button button-dark button-medium" href="/learn/course">
          Open the full course map
        </Link>
      ) : null}
    </section>
  );
}

function DashboardShell({ dashboard, onRetry }: Readonly<{
  dashboard: MemberDashboardWireResponse;
  onRetry(): void;
}>) {
  const seats = `${dashboard.access.reservedSeats} of ${dashboard.access.seatLimit} seats reserved`;
  if (dashboard.experience.state === "no_enrollment") {
    return (
      <StatePage
        heading="Academy setup is not complete"
        message="Your Academy access is active, but an enrollment has not been connected yet. We have not created or guessed one."
      >
        <RetryButton onRetry={onRetry} />
      </StatePage>
    );
  }

  return (
    <main className="production-dashboard">
      <header className="production-dashboard-heading">
        <span className="brand-mark">S</span>
        <span className="micro-label">Member dashboard</span>
        <h1>{dashboard.account.name}</h1>
        <p>Academy access is active · {seats}</p>
      </header>
      {dashboard.schemaVersion === 2 ? <ProductionCourseSpine dashboard={dashboard} /> : null}
      {dashboard.schemaVersion === 1 && dashboard.experience.state === "partial" ? (
        <section className="production-dashboard-panel" role="status">
          <span className="micro-label">Current status</span>
          <h2>Dashboard data is still coming online</h2>
          <p>
            Your account and access are confirmed. Higher-priority member modules are
            unavailable, so Syntholo will not invent a lesson or recommend a lower-priority action.
          </p>
          <RetryButton onRetry={onRetry} />
        </section>
      ) : dashboard.schemaVersion === 1 ? (
        <section className="production-dashboard-panel">
          <span className="micro-label">Current status</span>
          <h2>No action is currently available</h2>
          <p>Every dashboard projection completed and found no current required action.</p>
        </section>
      ) : null}
    </main>
  );
}

export function ProductionMemberDashboard() {
  const { getToken, isLoaded, isSignedIn, sessionId } = useAuth();
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !sessionId) return;
    const controller = new AbortController();
    const currentSessionId = sessionId;
    const memberApi = createMemberApiClient({ getToken });

    void (async () => {
      try {
        const requestedVersion = dashboardRequestVersion();
        const response = await memberApi("/v1/member/dashboard", {
          headers: { "syntholo-dashboard-version": requestedVersion },
          signal: controller.signal,
        });
        if (!response.ok) {
          const error = await parseApiError(response);
          if (controller.signal.aborted) return;
          if (response.status === 401 && error?.code === "UNAUTHENTICATED") {
            setResolution({ sessionId: currentSessionId, state: "account_unavailable" });
            return;
          }
          setResolution({
            sessionId: currentSessionId,
            state: "degraded",
            ...(error === null ? {} : { correlationId: error.correlationId }),
          });
          return;
        }
        const dashboard = await parseMemberDashboardResponse(response, requestedVersion);
        if (!controller.signal.aborted) {
          setResolution({ sessionId: currentSessionId, state: "resolved", dashboard });
        }
      } catch {
        if (!controller.signal.aborted) {
          setResolution({ sessionId: currentSessionId, state: "degraded" });
        }
      }
    })();
    return () => controller.abort();
  }, [getToken, isLoaded, isSignedIn, retry, sessionId]);

  const onRetry = () => setRetry((value) => value + 1);
  if (!isLoaded) {
    return <StatePage heading="Checking your Academy access" live message="We are confirming your sign-in and account access." />;
  }
  if (!isSignedIn) {
    return (
      <StatePage heading="Sign in to continue" message="Use your member account to open the Academy.">
        <Link className="button button-primary button-medium" href={{ pathname: "/sign-in" }}>
          Member sign in
        </Link>
      </StatePage>
    );
  }
  const current = resolution?.sessionId === sessionId ? resolution : null;
  if (current === null) {
    return <StatePage heading="Checking your Academy access" live message="We are confirming your sign-in and account access." />;
  }
  if (current.state === "account_unavailable") {
    return (
      <StatePage
        heading="Member account unavailable"
        message="We could not connect this sign-in to an active Syntholo member account."
      >
        <RetryButton onRetry={onRetry} />
      </StatePage>
    );
  }
  if (current.state === "degraded") {
    return (
      <StatePage
        heading="Dashboard temporarily unavailable"
        live
        message="We could not safely load your dashboard. No demo or stale member data has been shown."
      >
        {current.correlationId ? <p>Reference: {current.correlationId}</p> : null}
        <RetryButton onRetry={onRetry} />
      </StatePage>
    );
  }
  if (current.dashboard.experience.state === "access_required") {
    return (
      <StatePage
        heading="Academy access required"
        message="This account does not currently include Academy course access."
      >
        <Link className="button button-dark button-medium" href="/pricing">
          View program options
        </Link>
      </StatePage>
    );
  }
  return <DashboardShell dashboard={current.dashboard} onRetry={onRetry} />;
}
