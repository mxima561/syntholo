import { listLiveSessions } from "@syntholo/db";
import { requireStudentAccount } from "@/lib/server/accounts";

function icsDate(value: Date) {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export async function GET(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const account = await requireStudentAccount();
  const { sessionId } = await params;
  const sessions = await listLiveSessions(account.id);
  const session = sessions.find((item) => item.id === sessionId);
  if (!session) return new Response("Not found", { status: 404 });
  const endsAt = session.endsAt ?? new Date(session.startsAt.getTime() + 60 * 60 * 1000);
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Syntholo//Live Sessions//EN",
    "BEGIN:VEVENT",
    `UID:${session.id}@syntholo`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(session.startsAt)}`,
    `DTEND:${icsDate(endsAt)}`,
    `SUMMARY:${session.title.replaceAll("\n", " ")}`,
    `DESCRIPTION:${session.description.replaceAll("\n", " ")}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${session.title.replaceAll(" ", "-").toLowerCase()}.ics"`,
    },
  });
}
