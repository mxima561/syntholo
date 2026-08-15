"use client";

import { useAuth } from "@clerk/react";
import type { MemberDashboardV2Response } from "@syntholo/contracts/member-dashboard";
import Link from "next/link";
import { useEffect, useState } from "react";
import { createMemberApiClient } from "@/lib/api/client";
import {
  dashboardRequestVersion,
  parseMemberDashboardResponse,
  ProductionCourseSpine,
} from "./production-member-dashboard";

type Resolution =
  | { sessionId: string; state: "unavailable" }
  | { sessionId: string; state: "resolved"; dashboard: MemberDashboardV2Response };

export function ProductionCourseMap() {
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
        const dashboard = await parseMemberDashboardResponse(response, requestedVersion);
        if (dashboard.schemaVersion !== 2) throw new Error("COURSE_MAP_V2_REQUIRED");
        if (!controller.signal.aborted) setResolution({ sessionId: currentSessionId, state: "resolved", dashboard });
      } catch {
        if (!controller.signal.aborted) setResolution({ sessionId: currentSessionId, state: "unavailable" });
      }
    })();
    return () => controller.abort();
  }, [getToken, isLoaded, isSignedIn, retry, sessionId]);

  const current = resolution?.sessionId === sessionId ? resolution : null;
  if (!isLoaded || (isSignedIn && current === null)) {
    return (
      <main className="state-page" role="status">
        <span className="brand-mark">S</span>
        <h1>Loading your course</h1>
        <p>We are reading your pinned Academy enrollment.</p>
      </main>
    );
  }
  if (!isSignedIn) {
    return (
      <main className="state-page">
        <h1>Sign in to open your course</h1>
        <Link className="button button-primary button-medium" href={{ pathname: "/sign-in" }}>
          Member sign in
        </Link>
      </main>
    );
  }
  if (current === null || current.state !== "resolved") {
    return (
      <main className="state-page" role="status">
        <h1>Course temporarily unavailable</h1>
        <p>We could not safely load your enrollment. No demo course was shown.</p>
        <button className="button button-primary button-medium" onClick={() => setRetry((value) => value + 1)} type="button">
          Try again
        </button>
      </main>
    );
  }
  if (current.dashboard.experience.state === "access_required") {
    return (
      <main className="state-page">
        <h1>Academy access required</h1>
        <Link className="button button-dark button-medium" href="/pricing">View program options</Link>
      </main>
    );
  }
  if (current.dashboard.experience.state === "no_enrollment") {
    return (
      <main className="state-page" role="status">
        <h1>Academy enrollment pending</h1>
        <p>Your access is active, but no course enrollment is connected yet.</p>
        <button className="button button-primary button-medium" onClick={() => setRetry((value) => value + 1)} type="button">
          Check again
        </button>
      </main>
    );
  }
  return (
    <main className="member-page production-course-page">
      <ProductionCourseSpine dashboard={current.dashboard} showOpenCourseLink={false} />
    </main>
  );
}
