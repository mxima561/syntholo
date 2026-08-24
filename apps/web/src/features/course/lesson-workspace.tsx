"use client";

import { useState } from "react";
import { Check, ChevronDown, Download, FileText, RotateCcw } from "lucide-react";
import type { Lesson } from "@/lib/domain/types";
import { Button } from "@/components/ui/button";
import { LessonVideo } from "./lesson-video";
import { setLessonCompleteAction } from "@/app/learn/actions";

type LessonWorkspaceProps = {
  lesson: Lesson;
  initiallyComplete?: boolean;
  videoUrl?: string | null;
  onComplete?: (lessonId: string) => void;
};

export function LessonWorkspace({ lesson, initiallyComplete = false, videoUrl, onComplete }: LessonWorkspaceProps) {
  const [complete, setComplete] = useState(initiallyComplete);
  const [pending, setPending] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);

  async function markComplete(next: boolean) {
    setPending(true);
    setComplete(next);
    try {
      await setLessonCompleteAction(lesson.id, next);
      onComplete?.(lesson.id);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="lesson-workspace">
      <section className="lesson-main">
        {videoUrl ? (
          <LessonVideo src={videoUrl} title={lesson.title} durationMinutes={lesson.durationMinutes} />
        ) : (
          <div className="lesson-player">
            <div>
              <span>Transcript-first lesson</span>
              <strong>{lesson.durationMinutes} minutes</strong>
            </div>
            <p>Video is optional. Use the transcript and working template below — both count toward completion.</p>
          </div>
        )}

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
          <Button href="/learn/templates" size="small" variant="secondary"><Download size={14} /> Open templates</Button>
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
            <Button disabled={pending} onClick={() => markComplete(false)} size="small" variant="secondary"><RotateCcw size={14} /> Mark incomplete</Button>
          ) : (
            <Button disabled={pending} onClick={() => markComplete(true)} size="small"><Check size={14} /> Mark lesson complete</Button>
          )}
        </div>
        <div className="human-nudge">
          <span className="coach-avatar">NR</span>
          <div><strong>Need a second opinion?</strong><p>Send Naomi your draft and get a human response within two business days.</p></div>
          <Button href="/learn/support" size="small" variant="human">Ask a coach →</Button>
        </div>
      </aside>
    </div>
  );
}
