"use client";

import { useState } from "react";
import { Check, ChevronDown, Download, FileText, Play, RotateCcw } from "lucide-react";
import type { Lesson } from "@/lib/domain/types";
import { Button } from "@/components/ui/button";

type LessonWorkspaceProps = {
  lesson: Lesson;
  initiallyComplete?: boolean;
  onComplete?: (lessonId: string) => void;
};

export function LessonWorkspace({ lesson, initiallyComplete = false, onComplete }: LessonWorkspaceProps) {
  const [complete, setComplete] = useState(initiallyComplete);
  const [showTranscript, setShowTranscript] = useState(false);
  const [playing, setPlaying] = useState(false);

  function markComplete() {
    setComplete(true);
    onComplete?.(lesson.id);
  }

  return (
    <div className="lesson-workspace">
      <section className="lesson-main">
        <div className={`lesson-player ${playing ? "is-playing" : ""}`}>
          <button aria-label={playing ? "Pause lesson" : "Play lesson"} onClick={() => setPlaying((value) => !value)} type="button">
            <Play fill="currentColor" size={22} />
          </button>
          <div>
            <span>{playing ? "Playing practical lesson" : "Video lesson"}</span>
            <strong>{lesson.durationMinutes} minutes</strong>
          </div>
          <div className="player-timeline"><i /></div>
        </div>

        <div className="lesson-heading">
          <span className="micro-label">Lesson {String(lesson.number).padStart(2, "0")}</span>
          <h1>{lesson.title}</h1>
          <p>{lesson.summary}</p>
        </div>

        <div className="lesson-action-card">
          <div className="action-number">01</div>
          <div>
            <span className="micro-label">Do this in your business</span>
            <h2>{lesson.actionLabel}</h2>
            <p>Capture the decision in your shared implementation plan so your team can use it after the lesson.</p>
          </div>
        </div>

        <div className="lesson-resource-row">
          <FileText size={18} />
          <div><strong>Working template</strong><span>Editable worksheet · included</span></div>
          <Button size="small" variant="secondary"><Download size={14} /> Download</Button>
        </div>

        <button aria-expanded={showTranscript} className="transcript-toggle" onClick={() => setShowTranscript((value) => !value)} type="button">
          Transcript <ChevronDown className={showTranscript ? "rotate" : ""} size={17} />
        </button>
        {showTranscript ? (
          <div className="transcript-copy">
            {lesson.transcript.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
          </div>
        ) : null}
      </section>

      <aside className="lesson-rail">
        <div className={`completion-card ${complete ? "complete" : ""}`}>
          <span className="completion-icon">{complete ? <Check size={19} /> : lesson.number}</span>
          <h2>{complete ? "Lesson completed" : "Ready to apply this?"}</h2>
          <p>{complete ? "Nice work. Your course map and 30-day plan have been updated." : "Complete the practical action, then mark the lesson done."}</p>
          {complete ? (
            <Button onClick={() => setComplete(false)} size="small" variant="secondary"><RotateCcw size={14} /> Mark incomplete</Button>
          ) : (
            <Button onClick={markComplete} size="small"><Check size={14} /> Mark lesson complete</Button>
          )}
        </div>
        <div className="human-nudge">
          <span className="coach-avatar">NR</span>
          <div><strong>Need a second opinion?</strong><p>Send Naomi your draft and get a human response within two business days.</p></div>
          <Button href="/learn/support" size="small" variant="quiet">Ask a coach →</Button>
        </div>
      </aside>
    </div>
  );
}
