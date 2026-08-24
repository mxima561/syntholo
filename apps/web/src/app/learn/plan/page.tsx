import { ImplementationPlan } from "@/features/implementation/implementation-plan";
import { requireStudentAccount } from "@/lib/server/accounts";
import { getCompletedLessonIds } from "@/lib/server/courses";
import { listArtifacts, listWorkflows } from "@syntholo/db";

export const dynamic = "force-dynamic";

export default async function PlanPage() {
  const account = await requireStudentAccount();
  const [artifacts, workflows, completedLessonIds] = await Promise.all([
    listArtifacts(account.id),
    listWorkflows(account.id),
    getCompletedLessonIds(account.id),
  ]);

  return (
    <div className="member-page plan-page">
      <section className="page-intro">
        <div>
          <span className="eyebrow"><span className="eyebrow-dot" /> Guided implementation</span>
          <h1>Your 30-day build plan</h1>
          <p>Lessons teach the method. This workspace turns it into an operating system your team owns. Every save is stored on your student record {account.publicId}.</p>
        </div>
      </section>
      <ImplementationPlan
        completedLessons={completedLessonIds.length}
        initialArtifacts={artifacts.map((artifact) => ({
          id: artifact.id,
          kind: artifact.kind,
          title: artifact.title,
          status: artifact.status,
          version: artifact.version,
          body: artifact.body,
          reviewStatus: artifact.reviewStatus,
          updatedBy: artifact.updatedBy,
          updatedAt: artifact.updatedAt.toISOString(),
        }))}
        liveWorkflows={workflows.filter((workflow) => workflow.status === "live").length}
      />
    </div>
  );
}
