export const ACADEMY_UNAVAILABLE_CODE = "ACADEMY_UNAVAILABLE" as const;

export class AcademyUnavailableError extends Error {
  readonly code = ACADEMY_UNAVAILABLE_CODE;

  constructor(message = "Academy is temporarily unavailable.", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AcademyUnavailableError";
  }
}

export function isAcademyUnavailableError(error: unknown): error is AcademyUnavailableError {
  if (error instanceof AcademyUnavailableError) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === ACADEMY_UNAVAILABLE_CODE
  );
}

export function asAcademyUnavailable(error: unknown): AcademyUnavailableError {
  if (error instanceof AcademyUnavailableError) return error;
  return new AcademyUnavailableError("Academy is temporarily unavailable.", { cause: error });
}
