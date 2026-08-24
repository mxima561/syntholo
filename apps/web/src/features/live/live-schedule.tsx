"use client";

import { useState, useTransition } from "react";
import { CalendarPlus, Check, Clock3, Download, PlayCircle, UsersRound, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { rsvpSessionAction } from "@/app/learn/actions";

export type ScheduleSession = {
  id: string;
  title: string;
  description: string;
  startsAt: string;
  region: string;
  hostName: string;
  status: "scheduled" | "live" | "completed" | "canceled";
  rsvpCount: number;
  reservedByViewer: boolean;
  recordingUrl: string | null;
};

export function LiveSchedule({ sessions }: { sessions: ScheduleSession[] }) {
  const [items, setItems] = useState(sessions);
  const [pending, startTransition] = useTransition();
  const scheduled = items.filter((session) => session.status === "scheduled");
  const recordings = items.filter((session) => session.status === "completed" || session.recordingUrl);

  function reserve(sessionId: string) {
    setItems((current) => current.map((session) => session.id === sessionId
      ? { ...session, reservedByViewer: true, rsvpCount: session.rsvpCount + 1 }
      : session));
    startTransition(async () => {
      await rsvpSessionAction(sessionId);
    });
  }

  return (
    <div className="live-schedule">
      <section className="upcoming-sessions">
        {scheduled.length === 0 ? <p className="empty-note">No upcoming office hours yet. Check back after operations publishes the next session.</p> : null}
        {scheduled.map((session) => {
          const date = new Date(session.startsAt);
          return (
            <article className="session-card" key={session.id}>
              <div className="session-calendar">
                <span>{new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" }).format(date)}</span>
                <strong>{date.getUTCDate()}</strong>
                <small>{new Intl.DateTimeFormat("en", { weekday: "short", timeZone: "UTC" }).format(date)}</small>
              </div>
              <div className="session-copy">
                <div><span className="micro-label">{session.region}</span><i><span className="online-dot" /> Upcoming</i></div>
                <h2>{session.title}</h2>
                <p>{session.description}</p>
                <div className="session-meta">
                  <span><Clock3 size={13} /> {new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: "America/New_York" }).format(date)}</span>
                  <span><UsersRound size={13} /> {session.rsvpCount} going</span>
                  <span><Video size={13} /> Hosted by {session.hostName}</span>
                </div>
              </div>
              <div className="session-actions">
                <Button disabled={pending || session.reservedByViewer} onClick={() => reserve(session.id)} size="small" variant="milestone">
                  {session.reservedByViewer ? <Check size={14} /> : <CalendarPlus size={14} />} {session.reservedByViewer ? "Seat reserved" : "Reserve my seat"}
                </Button>
                {session.reservedByViewer ? (
                  <a className="button button-milestone button-small" href={`/learn/live/${session.id}/calendar`}>
                    <Download size={13} /> Add to calendar
                  </a>
                ) : null}
              </div>
            </article>
          );
        })}
      </section>
      <section className="recordings-section">
        <div className="section-title-row"><div><span className="micro-label">Session library</span><h2>Recent recordings</h2></div><span>Edited teaching + Q&amp;A</span></div>
        {recordings.length === 0 ? <p className="empty-note">Recordings appear here after a session is completed and the file is published.</p> : (
          <div className="recording-grid">{recordings.map((session) => (
            <article key={session.id}>
              <div className="recording-art"><PlayCircle size={38} /><span>Recording</span></div>
              <div>
                <span className="micro-label">{session.region}</span>
                <h3>{session.title}</h3>
                <p>{session.description}</p>
                {session.recordingUrl ? <a className="button button-secondary button-small" href={session.recordingUrl} rel="noreferrer" target="_blank">Watch recording</a> : <Button disabled size="small" variant="secondary">Recording pending</Button>}
              </div>
            </article>
          ))}</div>
        )}
      </section>
    </div>
  );
}
