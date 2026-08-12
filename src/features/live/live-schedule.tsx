"use client";

import { useState } from "react";
import { CalendarPlus, Check, Clock3, Download, PlayCircle, UsersRound, Video } from "lucide-react";
import type { LiveSession } from "@/lib/domain/types";
import { Button } from "@/components/ui/button";

export function LiveSchedule({ sessions }: { sessions: LiveSession[] }) {
  const [reserved, setReserved] = useState<string[]>([]);
  const scheduled = sessions.filter((session) => session.status === "scheduled");
  const recordings = sessions.filter((session) => session.hasRecording);

  return (
    <div className="live-schedule">
      <section className="upcoming-sessions">
        {scheduled.map((session) => {
          const date = new Date(session.startsAt);
          const isReserved = reserved.includes(session.id);
          return <article className="session-card" key={session.id}><div className="session-calendar"><span>{new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" }).format(date)}</span><strong>{date.getUTCDate()}</strong><small>{new Intl.DateTimeFormat("en", { weekday: "short", timeZone: "UTC" }).format(date)}</small></div><div className="session-copy"><div><span className="micro-label">{session.region}</span><i><span className="online-dot" /> Upcoming</i></div><h2>{session.title}</h2><p>{session.description}</p><div className="session-meta"><span><Clock3 size={13} /> {new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: "America/New_York" }).format(date)}</span><span><UsersRound size={13} /> {session.rsvpCount + Number(isReserved)} going</span><span><Video size={13} /> Hosted by {session.hostName}</span></div></div><div className="session-actions"><Button disabled={isReserved} onClick={() => setReserved((items) => [...items, session.id])} size="small">{isReserved ? <Check size={14} /> : <CalendarPlus size={14} />} {isReserved ? "Seat reserved" : "Reserve my seat"}</Button>{isReserved ? <button type="button"><Download size={13} /> Add to calendar</button> : null}</div></article>;
        })}
      </section>
      <section className="recordings-section"><div className="section-title-row"><div><span className="micro-label">Session library</span><h2>Recent recordings</h2></div><span>Edited teaching + Q&amp;A</span></div><div className="recording-grid">{recordings.map((session) => <article key={session.id}><div className="recording-art"><PlayCircle size={38} /><span>58:14</span></div><div><span className="micro-label">{session.region}</span><h3>{session.title}</h3><p>{session.description}</p><Button size="small" variant="secondary">Watch recording</Button></div></article>)}</div></section>
    </div>
  );
}
