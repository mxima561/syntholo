"use client";

import { useState, type FormEvent } from "react";
import { createPublicApiClient } from "@/lib/api/client";

export const WAITLIST_COPY = {
  headline: "Put AI to work in your life and your business.",
  subhead: "A practical school. Self-paced lessons, live sessions, and a person to help when you get stuck. First group is small.",
  cta: "Join the waitlist",
  success: "You're on the list. We'll write when the first sessions open.",
} as const;

type Status = "idle" | "submitting" | "invalid" | "failed" | "subscribed" | "already-subscribed";

const publicApi = createPublicApiClient();

export function WaitlistForm({ framed = false }: { framed?: boolean }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setStatus("submitting");
    try {
      const response = await publicApi("/v1/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, source: "school" }),
      });
      if (response.status === 400) {
        setStatus("invalid");
        return;
      }
      if (!response.ok) {
        setStatus("failed");
        return;
      }
      const body = await response.json() as { status?: string };
      setStatus(body.status === "already-subscribed" ? "already-subscribed" : "subscribed");
    } catch {
      setStatus("failed");
    }
  }

  const succeeded = status === "subscribed" || status === "already-subscribed";
  const body = (
    <>
      <h1>{WAITLIST_COPY.headline}</h1>
      <p className={framed ? undefined : "hero-lede"}>{WAITLIST_COPY.subhead}</p>
      {succeeded ? (
        <p role="status">{WAITLIST_COPY.success}</p>
      ) : (
        <form className="waitlist-form" onSubmit={(event) => void onSubmit(event)}>
          <label htmlFor="waitlist-email">Email</label>
          <input
            autoComplete="email"
            id="waitlist-email"
            inputMode="email"
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
          <button className="button button-primary button-large" disabled={status === "submitting"} type="submit">
            {WAITLIST_COPY.cta}
          </button>
          {status === "invalid" ? <p role="alert">Enter a valid email address.</p> : null}
          {status === "failed" ? <p role="alert">Could not join the waitlist. Try again.</p> : null}
        </form>
      )}
    </>
  );

  if (!framed) return body;
  return (
    <main className="marketing-page internal-waitlist">
      <section className="internal-waitlist-card">{body}</section>
    </main>
  );
}
