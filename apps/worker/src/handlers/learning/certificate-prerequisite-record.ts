import { LearningPrerequisiteInputError } from "@syntholo/database";
import { HandlerFailure } from "../index.js";

export type CertificatePrerequisiteRepositoryPort = Readonly<{
  recordCertificatePrerequisite(input: Readonly<{
    eventId: string;
    handlerName: "learning.certificate_prerequisite_record";
  }>, signal?: AbortSignal): Promise<Readonly<{ kind: "recorded" | "duplicate" }>>;
}>;

export function createCertificatePrerequisiteRecordHandler(repository: CertificatePrerequisiteRepositoryPort) {
  return async (event: Readonly<{ eventId: string; handlerName: string }>, signal: AbortSignal): Promise<void> => {
    if (event.handlerName !== "learning.certificate_prerequisite_record") {
      throw new HandlerFailure({ code: "JOB_INPUT_INVALID", permanent: true });
    }
    if (signal.aborted) throw new HandlerFailure({ code: "JOB_DEPENDENCY_UNAVAILABLE", permanent: false });
    try {
      await repository.recordCertificatePrerequisite({ eventId: event.eventId, handlerName: event.handlerName }, signal);
    } catch (error) {
      if (error instanceof LearningPrerequisiteInputError) {
        throw new HandlerFailure({ code: "JOB_INPUT_INVALID", permanent: true });
      }
      throw new HandlerFailure({ code: "JOB_DEPENDENCY_UNAVAILABLE", permanent: false });
    }
  };
}
