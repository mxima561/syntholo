const MAX_DELAY_MS = 3_600_000;
const BASE_DELAY_MS = 1_000;
const MAX_JITTER_MS = 250;

export function nextAttempt(attempt: number, now: Date): Date {
  const safeAttempt = Math.max(0, attempt);
  const exponential = BASE_DELAY_MS * 2 ** safeAttempt;
  const delay = Math.min(MAX_DELAY_MS, Number.isFinite(exponential) ? exponential : MAX_DELAY_MS);
  const jitter = Math.floor(Math.random() * (MAX_JITTER_MS + 1));
  return new Date(now.getTime() + delay + jitter);
}
