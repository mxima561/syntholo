"use client";

import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export const ACADEMY_UNAVAILABLE_HEADING = "Academy is temporarily unavailable.";
export const ACADEMY_UNAVAILABLE_BODY =
  "We could not load your workspace right now. Your work is still safe. Try again in a moment.";

export function AcademyUnavailable({ onRetry }: { onRetry?: () => void }) {
  return (
    <main className="state-page">
      <span className="brand-mark">S</span>
      <span className="micro-label">Temporarily unavailable</span>
      <h1>{ACADEMY_UNAVAILABLE_HEADING}</h1>
      <p>{ACADEMY_UNAVAILABLE_BODY}</p>
      {onRetry ? (
        <Button onClick={onRetry} variant="dark">
          <RotateCcw size={15} /> Try again
        </Button>
      ) : null}
      <Button href="/" variant="quiet">
        Back to Syntholo
      </Button>
    </main>
  );
}
