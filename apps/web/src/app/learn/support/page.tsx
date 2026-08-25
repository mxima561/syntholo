import { SupportInbox } from "@/features/support/support-inbox";
import { requireAcademyAccess } from "@/lib/server/accounts";
import { getThreadMessages, listThreadsForUser } from "@/lib/server/support";

export const dynamic = "force-dynamic";

export default async function SupportPage() {
  const { account, access } = await requireAcademyAccess();
  const summaries = await listThreadsForUser(account.id);
  const threadsWithMessages = await Promise.all(
    summaries.map(async (summary) => ({
      id: summary.id,
      subject: summary.subject,
      category: summary.category,
      status: summary.status,
      coachName: summary.coachName,
      updatedAt: summary.updatedAt.toISOString(),
      messages: (await getThreadMessages(summary.id, account.id)).map((message) => ({
        id: message.id,
        authorName: message.authorName,
        authorRole: message.authorRole,
        body: message.body,
        createdAt: message.createdAt.toISOString(),
      })),
    })),
  );
  const revision = threadsWithMessages
    .reduce((latest, thread) => Math.max(latest, new Date(thread.updatedAt).getTime()), 0)
    .toString();

  return (
    <div className="member-page support-page">
      <section className="page-intro">
        <div>
          <span className="eyebrow"><span className="eyebrow-dot" /> Real practitioner support</span>
          <h1>Your human support inbox</h1>
          <p>Every question and coach reply is saved here — nothing gets lost.</p>
        </div>
      </section>
      <SupportInbox
        canWrite={access.capabilities.support}
        identity={{
          name: `${account.firstName} ${account.lastName}`.trim() || account.email,
          initials: account.initials,
          business: "Member workspace",
        }}
        key={revision}
        threads={threadsWithMessages}
      />
    </div>
  );
}
