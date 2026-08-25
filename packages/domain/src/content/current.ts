import { snapshotFromAcademyCourse } from "./snapshot";
import { evaluateContentReadiness, toContentLaunchReadiness, type ContentApproval } from "./readiness";

export function currentAcademyLaunchReadiness(now = new Date(), approval: ContentApproval | null = null) {
  const report = evaluateContentReadiness(snapshotFromAcademyCourse());
  return { report, readiness: toContentLaunchReadiness(report, approval, now) };
}
