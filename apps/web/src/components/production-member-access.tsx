"use client";

import { useAuth } from "@clerk/react";
import { MemberAccessResponseSchema } from "@syntholo/contracts/entitlements";
import Link from "next/link";
import { useEffect, useState } from "react";
import { z } from "zod";
import { createMemberApiClient } from "@/lib/api/client";

const MemberActorSchema = z.object({
  kind: z.literal("member"),
  actorId: z.string().min(1),
  clerkUserId: z.string().min(1),
  accountId: z.string().uuid(),
  membershipId: z.string().uuid(),
  role: z.enum(["owner", "teammate"]),
  authenticatedAt: z.string().min(1),
}).strict();

type ResolvedMemberAccessState =
  | "not-provisioned"
  | "authorized"
  | "access-required"
  | "unavailable";

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
      <span className="micro-label">Member access</span>
      <h1>{heading}</h1>
      <p>{message}</p>
      {children}
    </main>
  );
}

export function ProductionMemberAccess() {
  const { getToken, isLoaded, isSignedIn, sessionId } = useAuth();
  const [resolution, setResolution] = useState<Readonly<{
    sessionId: string;
    state: ResolvedMemberAccessState;
  }> | null>(null);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) {
      return;
    }

    const controller = new AbortController();
    const memberApi = createMemberApiClient({ getToken });
    const currentSessionId = sessionId;

    void (async () => {
      try {
        const identityResponse = await memberApi("/v1/member/whoami", {
          signal: controller.signal,
        });
        if (identityResponse.status === 401) {
          setResolution({ sessionId: currentSessionId, state: "not-provisioned" });
          return;
        }
        if (!identityResponse.ok) {
          setResolution({ sessionId: currentSessionId, state: "unavailable" });
          return;
        }
        const actor = MemberActorSchema.safeParse(await identityResponse.json());
        if (!actor.success) {
          setResolution({ sessionId: currentSessionId, state: "unavailable" });
          return;
        }

        const accessResponse = await memberApi("/v1/member/access", {
          signal: controller.signal,
        });
        if (!accessResponse.ok) {
          setResolution({ sessionId: currentSessionId, state: "unavailable" });
          return;
        }
        const access = MemberAccessResponseSchema.safeParse(
          await accessResponse.json(),
        );
        if (!access.success || access.data.accountId !== actor.data.accountId) {
          setResolution({ sessionId: currentSessionId, state: "unavailable" });
          return;
        }
        setResolution({
          sessionId: currentSessionId,
          state: access.data.capabilities.academy_course
            ? "authorized"
            : "access-required",
        });
      } catch {
        if (!controller.signal.aborted) {
          setResolution({ sessionId: currentSessionId, state: "unavailable" });
        }
      }
    })();

    return () => controller.abort();
  }, [getToken, isLoaded, isSignedIn, sessionId]);

  if (!isLoaded) {
    return (
      <StatePage
        heading="Checking your Academy access"
        live
        message="We are confirming your sign-in and account access."
      />
    );
  }
  if (!isSignedIn) {
    return (
      <StatePage
        heading="Sign in to continue"
        message="Use your member account to open the Academy."
      >
        <Link className="button button-primary button-medium" href={{ pathname: "/sign-in" }}>
          Member sign in
        </Link>
      </StatePage>
    );
  }
  const state = resolution?.sessionId === sessionId ? resolution.state : "checking";
  if (state === "not-provisioned") {
    return (
      <StatePage
        heading="Account not provisioned"
        message="Your sign-in is valid, but it is not connected to a Syntholo member account yet."
      />
    );
  }
  if (state === "authorized") {
    return (
      <StatePage
        heading="Academy access confirmed"
        message="Your member account and Academy entitlement are active."
      />
    );
  }
  if (state === "access-required") {
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
  if (state === "unavailable") {
    return (
      <StatePage
        heading="Access temporarily unavailable"
        message="We could not safely confirm your member access. Please try again shortly."
      />
    );
  }
  return (
    <StatePage
      heading="Checking your Academy access"
      live
      message="We are confirming your sign-in and account access."
    />
  );
}
