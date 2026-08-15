import { DatabaseDependencyUnavailableError, ImplementationCompletionInputError } from "@syntholo/database";
import { HandlerFailure } from "../index.js";

export type ImplementationCompletionRepositoryPort = Readonly<{
  recordCourseCompletion(input: Readonly<{
    eventId: string;
    handlerName: "implementation.completion_recompute";
  }>, signal?: AbortSignal): Promise<Readonly<{ kind: "recorded" | "duplicate" }>>;
}>;

export function createImplementationCompletionRecomputeHandler(repository: ImplementationCompletionRepositoryPort) {
  return async (event: Readonly<{ eventId: string; handlerName: string }>, signal: AbortSignal): Promise<void> => {
    if (event.handlerName !== "implementation.completion_recompute") {
      throw new HandlerFailure({ code: "JOB_INPUT_INVALID", permanent: true });
    }
    if (signal.aborted) throw new HandlerFailure({ code: "JOB_DEPENDENCY_UNAVAILABLE", permanent: false });
    try {
      await repository.recordCourseCompletion({ eventId: event.eventId, handlerName: event.handlerName }, signal);
    } catch (error) {
      if (error instanceof ImplementationCompletionInputError) {
        throw new HandlerFailure({ code: "JOB_INPUT_INVALID", permanent: true });
      }
      if (error instanceof DatabaseDependencyUnavailableError) {
        throw new HandlerFailure({ code: "JOB_DEPENDENCY_UNAVAILABLE", permanent: false });
      }
      throw error;
    }
  };
}
