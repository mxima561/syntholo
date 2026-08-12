import type { SupportThreadStatus } from "@/lib/domain/types";

function isBusinessDay(date: Date) {
  const day = date.getUTCDay();
  return day !== 0 && day !== 6;
}

export function addBusinessHours(start: Date, hours: number) {
  const result = new Date(start);
  let remaining = hours;

  while (remaining >= 8) {
    result.setUTCDate(result.getUTCDate() + 1);
    while (!isBusinessDay(result)) result.setUTCDate(result.getUTCDate() + 1);
    remaining -= 8;
  }
  if (remaining > 0) result.setUTCHours(result.getUTCHours() + remaining);
  return result;
}

export function getSlaState(input: { now: Date; dueAt: Date; status: SupportThreadStatus }) {
  if (input.status === "waiting_on_customer" || input.status === "resolved" || input.status === "closed") return "paused";
  const hoursRemaining = (input.dueAt.getTime() - input.now.getTime()) / 3_600_000;
  if (hoursRemaining <= 0) return "breached";
  if (hoursRemaining <= 8) return "warning";
  return "healthy";
}
