import { currentAcademyLaunchReadiness } from "@syntholo/domain";
import type { ContentApproval } from "@syntholo/domain/content";

export function evaluateLaunchReadiness(now = new Date(), approval: ContentApproval | null = null) {
  return currentAcademyLaunchReadiness(now, approval);
}
