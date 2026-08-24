import Link from "next/link";
import type { Route } from "next";
import {
  Check,
  Compass,
  LayoutDashboard,
  Play,
  Rocket,
  ShieldCheck,
  TrendingUp,
  UsersRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";

const WAVE = [0, 68, 108, 52, 0, -68, -108, -52];

const STAGE_VISUALS = [
  { icon: Compass, tone: "teal" },
  { icon: ShieldCheck, tone: "coral" },
  { icon: TrendingUp, tone: "gold" },
  { icon: UsersRound, tone: "navy" },
  { icon: LayoutDashboard, tone: "teal" },
  { icon: Rocket, tone: "coral" },
] as const;

export type CourseMapLesson = {
  id: string;
  number: number;
  title: string;
  durationMinutes: number;
};

export type CourseMapStage = {
  id: string;
  number: number;
  title: string;
  shortTitle: string;
  lessons: CourseMapLesson[];
};

export type CourseMapCourse = {
  title: string;
  stages: CourseMapStage[];
};

type CourseMapProps = {
  course: CourseMapCourse;
  completedLessonIds: string[];
  activeLessonId: string | null;
};

export function CourseMap({ course, completedLessonIds, activeLessonId }: CourseMapProps) {
  const allLessons = course.stages.flatMap((stage) => stage.lessons);
  const total = allLessons.length;
  const completeCount = completedLessonIds.length;
  const continueLesson =
    (activeLessonId ? allLessons.find((lesson) => lesson.id === activeLessonId) : undefined) ??
    allLessons.find((lesson) => !completedLessonIds.includes(lesson.id)) ??
    allLessons.at(-1) ??
    null;
  const allDone = total > 0 && completeCount >= total;
  const continueHref = (continueLesson ? `/learn/course/${continueLesson.id}` : "/learn/plan") as Route;

  let lessonIndex = 0;

  return (
    <div className="course-map">
      <section className="page-intro course-hero">
        <div>
          <span className="eyebrow"><span className="eyebrow-dot" /> Course path</span>
          <h1>{course.title}</h1>
          <p>
            {course.stages.length} stages · {total} lessons. Follow the bubbles — one practical step at a time.
          </p>
        </div>
        <div className="course-hero-aside">
          <CourseRing complete={completeCount} total={total} />
          {continueLesson ? (
            <Button href={continueHref}>
              {allDone ? "Review" : "Continue"}
              <span aria-hidden="true" className="course-hero-next">{continueLesson.title}</span>
            </Button>
          ) : null}
        </div>
      </section>

      <div className="course-path">
        <div aria-hidden="true" className="course-path-art">
          <span className="course-orb course-orb-teal" />
          <span className="course-orb course-orb-coral" />
          <span className="course-orb course-orb-gold" />
          <span className="course-spark" />
        </div>
        {course.stages.map((stage) => {
          const visual = STAGE_VISUALS[(stage.number - 1) % STAGE_VISUALS.length] ?? STAGE_VISUALS[0];
          const Icon = visual.icon;
          const doneInStage = stage.lessons.filter((lesson) => completedLessonIds.includes(lesson.id)).length;
          return (
            <section className={`course-unit course-unit-${visual.tone}`} key={stage.id}>
              <header className="course-unit-banner">
                <span>Stage {String(stage.number).padStart(2, "0")}</span>
                <h2>{stage.shortTitle || stage.title}</h2>
                <i>{doneInStage}/{stage.lessons.length}</i>
              </header>
              <ol className="course-path-nodes">
                {stage.lessons.map((lesson) => {
                  const index = lessonIndex;
                  lessonIndex += 1;
                  const complete = completedLessonIds.includes(lesson.id);
                  const current = lesson.id === continueLesson?.id && !allDone;
                  const state = complete ? "is-complete" : current ? "is-current" : "is-upcoming";
                  const shift = WAVE[index % WAVE.length];
                  const label = [
                    `Lesson ${lesson.number}: ${lesson.title}`,
                    complete ? "completed" : current ? "current" : "upcoming",
                    `${lesson.durationMinutes} minutes`,
                  ].join(" · ");
                  return (
                    <li
                      className="course-node"
                      key={lesson.id}
                      style={{ ["--node-shift" as string]: `${shift}px` }}
                    >
                      <Link
                        aria-current={current ? "step" : undefined}
                        aria-label={label}
                        className={`course-node-link ${state}`}
                        href={`/learn/course/${lesson.id}` as Route}
                      >
                        {current ? <span aria-hidden="true" className="course-speech">Start</span> : null}
                        <span className="course-bubble">
                          <span className="course-bubble-face">
                            {complete ? <Check size={26} strokeWidth={2.6} /> : current ? <Play fill="currentColor" size={22} /> : <Icon size={22} />}
                          </span>
                        </span>
                        <strong className="course-node-label">{lesson.title}</strong>
                        <span className="course-node-meta">{lesson.durationMinutes} min</span>
                      </Link>
                    </li>
                  );
                })}
              </ol>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function CourseRing({ complete, total }: { complete: number; total: number }) {
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const progress = total === 0 ? 0 : complete / total;

  return (
    <div aria-hidden="true" className="course-ring">
      <svg viewBox="0 0 64 64">
        <circle className="course-ring-track" cx="32" cy="32" r={radius} />
        <circle
          className="course-ring-fill"
          cx="32"
          cy="32"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
          transform="rotate(-90 32 32)"
        />
      </svg>
      <span>
        {complete}
        <small>/{total}</small>
      </span>
    </div>
  );
}
