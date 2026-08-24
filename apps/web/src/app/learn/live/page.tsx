import { LiveSchedule } from "@/features/live/live-schedule";
import { requireStudentAccount } from "@/lib/server/accounts";
import { listLiveSessions } from "@syntholo/db";

export const dynamic = "force-dynamic";

export default async function LivePage() {
  const account = await requireStudentAccount();
  const sessions = await listLiveSessions(account.id);
  return (
    <div className="member-page live-page">
      <section className="page-intro">
        <div>
          <span className="eyebrow"><span className="eyebrow-dot" /> Human-led learning</span>
          <h1>Live sessions</h1>
          <p>Bring the real workflow you are building. Leave with a specific decision and next action.</p>
        </div>
      </section>
      <LiveSchedule
        sessions={sessions.map((session) => ({
          id: session.id,
          title: session.title,
          description: session.description,
          startsAt: session.startsAt.toISOString(),
          region: session.region,
          hostName: session.hostName,
          status: session.status,
          rsvpCount: session.rsvpCount,
          reservedByViewer: session.reservedByViewer,
          recordingUrl: session.recordingUrl,
        }))}
      />
    </div>
  );
}
