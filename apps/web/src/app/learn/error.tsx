"use client";

import { AcademyUnavailable } from "@/components/academy-unavailable";

export default function LearnErrorPage({
  retry,
  reset,
}: {
  error: Error & { digest?: string };
  retry?: () => void;
  reset?: () => void;
}) {
  const onRetry = retry ?? reset;
  return <AcademyUnavailable onRetry={onRetry} />;
}
