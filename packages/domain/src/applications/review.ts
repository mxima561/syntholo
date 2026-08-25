export const APPLICATION_STATUSES = [
  "submitted",
  "needs_information",
  "approved",
  "declined",
  "checkout_sent",
  "purchased",
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

const ALLOWED: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
  submitted: ["needs_information", "approved", "declined"],
  needs_information: ["submitted", "declined"],
  approved: ["checkout_sent", "declined"],
  declined: [],
  checkout_sent: ["purchased"],
  purchased: [],
};

export class ApplicationTransitionError extends Error {
  readonly code = "INVALID_APPLICATION_TRANSITION";

  constructor(from: ApplicationStatus, to: ApplicationStatus) {
    super(`INVALID_APPLICATION_TRANSITION: ${from} -> ${to}`);
    this.name = "ApplicationTransitionError";
  }
}

export function transitionApplication(from: ApplicationStatus, to: ApplicationStatus): ApplicationStatus {
  if (!ALLOWED[from].includes(to)) {
    throw new ApplicationTransitionError(from, to);
  }
  return to;
}
