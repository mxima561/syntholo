import { HandlerFailure } from "../index.js";

export type ContentReadinessRepositoryPort = Readonly<{
  recompute(input: Readonly<{
    eventId: string;
    handlerName: "content.readiness_recompute";
  }>): Promise<Readonly<{ kind: "evaluated" }>>;
}>;

export function createContentReadinessRecomputeHandler(
  repository: ContentReadinessRepositoryPort,
): (event: Readonly<{ eventId: string; handlerName: string }>, signal: AbortSignal) => Promise<void> {
  return async (event, signal) => {
    if (event.handlerName !== "content.readiness_recompute") {
      throw new HandlerFailure({ code: "JOB_INPUT_INVALID", permanent: true });
    }
    if (signal.aborted) {
      throw new HandlerFailure({ code: "JOB_DEPENDENCY_UNAVAILABLE", permanent: false });
    }
    try {
      await repository.recompute({
        eventId: event.eventId,
        handlerName: "content.readiness_recompute",
      });
    } catch {
      throw new HandlerFailure({ code: "JOB_DEPENDENCY_UNAVAILABLE", permanent: false });
    }
  };
}
