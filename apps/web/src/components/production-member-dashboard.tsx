"use client";

import { useAuth } from "@clerk/react";
import {
  MemberDashboardResponseSchema,
  type MemberDashboardResponse,
} from "@syntholo/contracts/member-dashboard";
import { ApiErrorSchema } from "@syntholo/contracts/http";
import Link from "next/link";
import { useEffect, useState } from "react";
import { createMemberApiClient } from "@/lib/api/client";

type Resolution = Readonly<
  | { sessionId: string; state: "account_unavailable" }
  | { sessionId: string; state: "degraded"; correlationId?: string }
  | { sessionId: string; state: "resolved"; dashboard: MemberDashboardResponse }
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

async function parseDashboard(response: Response): Promise<MemberDashboardResponse> {
  if (
    !response.ok
    || !/^application\/json(?:;|$)/iu.test(response.headers.get("content-type") ?? "")
    || response.headers.get("syntholo-dashboard-version") !== "1"
  ) throw new Error("MEMBER_DASHBOARD_RESPONSE_INVALID");
  const parsed = MemberDashboardResponseSchema.safeParse(await response.json());
  if (!parsed.success || parsed.data.schemaVersion !== 1) {
    throw new Error("MEMBER_DASHBOARD_RESPONSE_INVALID");
  }
  return parsed.data;
}

function RetryButton({ onRetry }: Readonly<{ onRetry(): void }>) {
  return (
    <button className="button button-primary button-medium" onClick={onRetry} type="button">
      Try again
    </button>
  );
}

function DashboardShell({ dashboard, onRetry }: Readonly<{
  dashboard: MemberDashboardResponse;
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
      {dashboard.experience.state === "partial" ? (
        <section className="production-dashboard-panel" role="status">
          <span className="micro-label">Current status</span>
          <h2>Dashboard data is still coming online</h2>
          <p>
            Your account and access are confirmed. Higher-priority member modules are
            unavailable, so Syntholo will not invent a lesson or recommend a lower-priority action.
          </p>
          <RetryButton onRetry={onRetry} />
        </section>
      ) : (
        <section className="production-dashboard-panel">
          <span className="micro-label">Current status</span>
          <h2>No action is currently available</h2>
          <p>Every dashboard projection completed and found no current required action.</p>
        </section>
      )}
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
        const response = await memberApi("/v1/member/dashboard", {
          headers: { "syntholo-dashboard-version": "1" },
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
        const dashboard = await parseDashboard(response);
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
