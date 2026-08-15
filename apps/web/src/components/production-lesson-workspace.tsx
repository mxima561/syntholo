"use client";

import { useAuth } from "@clerk/react";
import MuxPlayer from "@mux/mux-player-react/lazy";
import {
  CompleteLessonResponseSchema,
  LessonPlaybackResponseSchema,
  MemberLessonProgressSchema,
  MemberLessonResponseSchema,
  type LessonPlaybackResponse,
  type MemberLessonProgress,
  type MemberLessonResponse,
} from "@syntholo/contracts/learning";
import type { LessonBlock, StructuredTextDocument } from "@syntholo/contracts/content";
import { ApiErrorSchema } from "@syntholo/contracts/http";
import Link from "next/link";
import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createMemberApiClient } from "@/lib/api/client";

type WorkspaceState =
  | { sessionId: string; lessonId: string; state: "unavailable" }
  | { sessionId: string; lessonId: string; state: "access_lost" }
  | { sessionId: string; lessonId: string; state: "locked"; availableAt: string }
  | {
      sessionId: string;
      lessonId: string;
      state: "resolved";
      lesson: MemberLessonResponse;
      playback: LessonPlaybackResponse;
    };

class PlaybackDependencyUnavailable extends Error {}

function degradedPlayback(lesson: MemberLessonResponse): LessonPlaybackResponse {
  return LessonPlaybackResponseSchema.parse({
    schemaVersion: 1,
    lessonVersionId: lesson.lessonVersionId,
    playbackStatus: "degraded",
    reason: "MUX_UNAVAILABLE",
    fallback: {
      title: lesson.title,
      summary: lesson.summary,
      blocks: lesson.blocks,
      transcript: lesson.transcript,
      resources: lesson.resources,
    },
  });
}

async function parseJson<T>(response: Response, parse: (value: unknown) => T): Promise<T> {
  if (!response.ok || !/^application\/json(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) {
    throw new Error("LEARNING_RESPONSE_UNAVAILABLE");
  }
  return parse(await response.json());
}

async function lockedAvailableAt(response: Response): Promise<string | null> {
  if (response.status !== 403 || !/^application\/json(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) return null;
  const parsed = ApiErrorSchema.safeParse(await response.clone().json().catch(() => null));
  const value = parsed.success && parsed.data.error.code === "LESSON_NOT_RELEASED"
    ? parsed.data.error.details?.availableAt
    : null;
  if (typeof value !== "string") return null;
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) && instant.toISOString() === value ? value : null;
}

type DocumentNode = Readonly<{
  type: string;
  content?: readonly DocumentNode[];
  href?: string;
  language?: string;
  level?: 2 | 3;
  marks?: readonly Readonly<{ type: string; href?: string }>[];
  start?: number;
  text?: string;
}>;

function renderInline(node: DocumentNode, key: string): ReactNode {
  if (node.type === "hard_break") return <br key={key} />;
  let value: ReactNode = node.text;
  for (const [index, mark] of [...(node.marks ?? [])].reverse().entries()) {
    const markKey = `${key}-mark-${index}`;
    if (mark.type === "bold") value = <strong key={markKey}>{value}</strong>;
    else if (mark.type === "italic") value = <em key={markKey}>{value}</em>;
    else if (mark.type === "code") value = <code key={markKey}>{value}</code>;
    else if (mark.type === "link" && mark.href) value = <a href={mark.href} key={markKey} rel="noreferrer" target="_blank">{value}</a>;
  }
  return <span key={key}>{value}</span>;
}

function renderBlockNode(node: DocumentNode, key: string): ReactNode {
  const inline = () => node.content?.map((child, index) => renderInline(child, `${key}-${index}`));
  switch (node.type) {
    case "paragraph": return <p key={key}>{inline()}</p>;
    case "heading": return node.level === 2 ? <h2 key={key}>{inline()}</h2> : <h3 key={key}>{inline()}</h3>;
    case "blockquote": return <blockquote key={key}>{node.content?.map((child, index) => renderBlockNode(child, `${key}-${index}`))}</blockquote>;
    case "bullet_list": return <ul key={key}>{node.content?.map((child, index) => renderBlockNode(child, `${key}-${index}`))}</ul>;
    case "ordered_list": return <ol key={key} start={node.start}>{node.content?.map((child, index) => renderBlockNode(child, `${key}-${index}`))}</ol>;
    case "list_item": return <li key={key}>{node.content?.map((child, index) => renderBlockNode(child, `${key}-${index}`))}</li>;
    case "code_block": return <pre key={key}><code data-language={node.language}>{node.text}</code></pre>;
    default: return null;
  }
}

function renderDocument(document: StructuredTextDocument): ReactNode {
  return (document.content as readonly DocumentNode[]).map((node, index) =>
    renderBlockNode(node, `document-${index}`));
}

function LessonContentBlock({ block }: Readonly<{ block: LessonBlock }>) {
  switch (block.type) {
    case "video":
    case "resource_list":
      return null;
    case "action":
      return (
        <section className="production-action-block" id={block.blockId}>
          <span className="micro-label">Do this in your business</span>
          <h2>{block.title}</h2>
          <p>{block.instructions}</p>
        </section>
      );
    case "checklist":
      return (
        <section className="production-content-block" id={block.blockId}>
          <h2>{block.title}</h2>
          <ul>{block.items.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
      );
    case "recommendation":
      return (
        <section className="production-content-block" id={block.blockId}>
          <h2>{block.title}</h2><p>{block.rationale}</p>
          {block.externalHttpsUrl ? <a href={block.externalHttpsUrl} rel="noreferrer" target="_blank">Open recommendation</a> : null}
        </section>
      );
    case "callout":
      return <aside className={`production-callout is-${block.tone}`} id={block.blockId}>{renderDocument(block.document)}</aside>;
    case "disclosure":
      return (
        <aside className="production-disclosure" id={block.blockId}>
          <strong>Disclosure · {block.disclosureKind}</strong>
          {renderDocument(block.document)}
        </aside>
      );
    case "rich_text":
      return <section className="production-content-block" id={block.blockId}>{renderDocument(block.document)}</section>;
  }
}

function byteSize(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${Math.ceil(value / 1_024)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

export function ProductionLessonWorkspace({ lessonId }: Readonly<{ lessonId: string }>) {
  const { getToken, isLoaded, isSignedIn, sessionId } = useAuth();
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [activePath, setActivePath] = useState<"video" | "transcript">("video");
  const [progress, setProgress] = useState<MemberLessonProgress | null>(null);
  const [saving, setSaving] = useState(false);
  const [resumeFailed, setResumeFailed] = useState(false);
  const [completionState, setCompletionState] = useState<"idle" | "saving" | "complete" | "failed">("idle");
  const [nextLessonId, setNextLessonId] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const completionIntent = useRef<{ key: string; lessonId: string; sessionId: string } | null>(null);
  const pendingResume = useRef<Readonly<{
    expectedVersion: number;
    path: "video" | "transcript";
    position: { seconds: number } | { blockId: string };
  }> | null>(null);
  const generation = useRef(0);
  const [usedPaths, setUsedPaths] = useState<ReadonlySet<"video" | "transcript">>(new Set());
  const playerRef = useRef<HTMLElement & { currentTime: number; pause(): void } | null>(null);
  const videoPlayed = useRef(false);
  const videoDirty = useRef(false);
  const restoredTranscript = useRef<string | null>(null);
  const currentWorkspace = workspace !== null && workspace.sessionId === sessionId && workspace.lessonId === lessonId
    ? workspace
    : null;

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !sessionId) return;
    const controller = new AbortController();
    const currentGeneration = ++generation.current;
    const currentSessionId = sessionId;
    const api = createMemberApiClient({ getToken });
    const player = playerRef.current;
    player?.pause();
    void (async () => {
      try {
        const [lessonResponse, playbackResponse] = await Promise.all([
          api(`/v1/member/lessons/${lessonId}`, { signal: controller.signal }),
          api(`/v1/member/lessons/${lessonId}/playback`, { signal: controller.signal }),
        ]);
        const availableAt = await lockedAvailableAt(lessonResponse);
        if (availableAt !== null) {
          if (!controller.signal.aborted && generation.current === currentGeneration) {
            setWorkspace({ sessionId: currentSessionId, lessonId, state: "locked", availableAt });
          }
          return;
        }
        const lesson = await parseJson(lessonResponse, (value) => MemberLessonResponseSchema.parse(value));
        const playback = await parseJson(playbackResponse, (value) => LessonPlaybackResponseSchema.parse(value));
        if (lesson.lessonVersionId !== playback.lessonVersionId) throw new Error("LESSON_PLAYBACK_VERSION_MISMATCH");
        if (!controller.signal.aborted && generation.current === currentGeneration) {
          setWorkspace({ sessionId: currentSessionId, lessonId, state: "resolved", lesson, playback });
          setProgress(lesson.progress);
          setCompletionState(lesson.progress.state === "completed" ? "complete" : "idle");
          setNextLessonId(lesson.nextRequiredLessonId);
          setActivePath(lesson.progress.lastPath === "transcript" || playback.playbackStatus === "degraded"
            ? "transcript"
            : "video");
          setUsedPaths(new Set(lesson.progress.lastPath === null ? [] : [lesson.progress.lastPath]));
          setResumeFailed(false);
          pendingResume.current = null;
        }
      } catch {
        if (!controller.signal.aborted && generation.current === currentGeneration) {
          setWorkspace({ sessionId: currentSessionId, lessonId, state: "unavailable" });
        }
      }
    })();
    return () => {
      controller.abort();
      if (generation.current === currentGeneration) generation.current += 1;
      videoPlayed.current = false;
      videoDirty.current = false;
      player?.pause();
    };
  }, [getToken, isLoaded, isSignedIn, lessonId, retry, sessionId]);

  const refreshPlayback = useCallback(async () => {
    if (currentWorkspace?.state !== "resolved" || !sessionId) return;
    const currentGeneration = generation.current;
    const currentSessionId = sessionId;
    try {
      const api = createMemberApiClient({ getToken });
      const response = await api(`/v1/member/lessons/${lessonId}/playback`);
      if (response.status === 401 || response.status === 403) {
        playerRef.current?.pause();
        if (generation.current === currentGeneration) {
          setWorkspace({ sessionId: currentSessionId, lessonId, state: "access_lost" });
        }
        return;
      }
      if ([429, 502, 503, 504].includes(response.status)) throw new PlaybackDependencyUnavailable();
      const playback = await parseJson(response, (value) => LessonPlaybackResponseSchema.parse(value));
      if (playback.lessonVersionId !== currentWorkspace.lesson.lessonVersionId) throw new Error("LESSON_PLAYBACK_VERSION_MISMATCH");
      if (generation.current !== currentGeneration) return;
      setWorkspace((current) => current?.state === "resolved" && current.sessionId === currentSessionId && current.lessonId === lessonId ? { ...current, playback } : current);
      if (playback.playbackStatus !== "ready") playerRef.current?.pause();
    } catch (error) {
      playerRef.current?.pause();
      if (generation.current !== currentGeneration) return;
      if (error instanceof Error && error.message === "MEMBER_SESSION_REQUIRED") {
        setWorkspace({ sessionId: currentSessionId, lessonId, state: "access_lost" });
      } else if (error instanceof PlaybackDependencyUnavailable || error instanceof TypeError) {
        setWorkspace((current) => current?.state === "resolved" && current.sessionId === currentSessionId && current.lessonId === lessonId
          ? { ...current, playback: degradedPlayback(current.lesson) }
          : current);
      } else {
        setWorkspace({ sessionId: currentSessionId, lessonId, state: "unavailable" });
      }
    }
  }, [currentWorkspace, getToken, lessonId, sessionId]);

  useEffect(() => {
    if (currentWorkspace?.state !== "resolved" || currentWorkspace.playback.playbackStatus !== "ready") return;
    const delay = Math.max(0, new Date(currentWorkspace.playback.mux.refreshAfter).getTime() - Date.now());
    const timer = window.setTimeout(() => void refreshPlayback(), delay);
    return () => window.clearTimeout(timer);
  }, [currentWorkspace, refreshPlayback]);

  useEffect(() => {
    if (currentWorkspace?.state !== "resolved" || activePath !== "transcript" || progress?.lastPath !== "transcript") return;
    const blockId = progress.position.blockId;
    const restorationKey = `${currentWorkspace.sessionId}:${currentWorkspace.lessonId}:${progress.revision ?? 0}:${blockId}`;
    if (restoredTranscript.current === restorationKey) return;
    restoredTranscript.current = restorationKey;
    document.getElementById(`transcript-${blockId}`)?.scrollIntoView?.({ block: "center" });
  }, [activePath, currentWorkspace, progress]);

  async function submitResume(intent: NonNullable<typeof pendingResume.current>) {
    if (currentWorkspace?.state !== "resolved" || progress?.state === "completed" || saving || !sessionId) return;
    const currentGeneration = generation.current;
    const currentSessionId = sessionId;
    setSaving(true);
    setResumeFailed(false);
    try {
      const api = createMemberApiClient({ getToken });
      const response = await api(`/v1/member/lessons/${lessonId}/resume`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(intent),
      });
      const next = await parseJson(response, (value) => MemberLessonProgressSchema.parse(value));
      if (generation.current !== currentGeneration || sessionId !== currentSessionId) return;
      setProgress(next);
      setUsedPaths((current) => new Set([...current, intent.path]));
      pendingResume.current = null;
    } catch {
      if (generation.current === currentGeneration) setResumeFailed(true);
    } finally {
      if (generation.current === currentGeneration) setSaving(false);
    }
  }

  async function saveResume(path: "video" | "transcript", position: { seconds: number } | { blockId: string }) {
    const intent = { expectedVersion: progress?.revision ?? 0, path, position } as const;
    pendingResume.current = intent;
    await submitResume(intent);
  }

  async function completeLesson() {
    if (currentWorkspace?.state !== "resolved" || completionState === "saving" || completionState === "complete" || !sessionId) return;
    const currentGeneration = generation.current;
    const currentSessionId = sessionId;
    if (completionIntent.current?.sessionId !== sessionId || completionIntent.current.lessonId !== lessonId) {
      completionIntent.current = { key: `lesson-complete-${crypto.randomUUID()}`, lessonId, sessionId };
    }
    const completionPaths = new Set([...usedPaths, activePath]);
    const method = completionPaths.size > 1
      ? "mixed"
      : completionPaths.values().next().value ?? activePath;
    setCompletionState("saving");
    try {
      const api = createMemberApiClient({ getToken });
      const response = await api(`/v1/member/lessons/${lessonId}/complete`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": completionIntent.current.key,
        },
        body: JSON.stringify({ method }),
      });
      const completion = await parseJson(response, (value) => CompleteLessonResponseSchema.parse(value));
      if (generation.current !== currentGeneration || sessionId !== currentSessionId) return;
      setNextLessonId(completion.nextRequiredLessonId);
      setCompletionState("complete");
    } catch {
      if (generation.current === currentGeneration) setCompletionState("failed");
    }
  }

  if (!isLoaded || (isSignedIn && currentWorkspace === null)) {
    return <main className="state-page" role="status"><h1>Checking your Academy access</h1><p>Loading this lesson from your pinned enrollment.</p></main>;
  }
  if (!isSignedIn) {
    return <main className="state-page"><h1>Sign in to open this lesson</h1><Link className="button button-primary button-medium" href={{ pathname: "/sign-in" }}>Member sign in</Link></main>;
  }
  if (currentWorkspace?.state === "locked") {
    return (
      <main className="state-page">
        <span className="micro-label">Academy lesson</span>
        <h1>This lesson is not released yet</h1>
        <p>It becomes available {new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(currentWorkspace.availableAt))} UTC.</p>
        <Link className="button button-secondary button-medium" href="/learn/course">Back to course map</Link>
      </main>
    );
  }
  if (currentWorkspace?.state === "access_lost") {
    return (
      <main className="state-page" role="status">
        <h1>Access could not be reconfirmed</h1>
        <p>Playback stopped and no lesson content is being shown. Sign in again or retry your account check.</p>
        <button className="button button-primary button-medium" onClick={() => setRetry((value) => value + 1)} type="button">Recheck access</button>
      </main>
    );
  }
  if (currentWorkspace === null || currentWorkspace.state !== "resolved") {
    return (
      <main className="state-page" role="status"><h1>Lesson temporarily unavailable</h1><p>No demo or stale lesson was shown.</p>
        <button className="button button-primary button-medium" onClick={() => setRetry((value) => value + 1)} type="button">Try again</button>
      </main>
    );
  }

  const { lesson, playback } = currentWorkspace;
  const resumeSeconds = progress?.lastPath === "video" ? progress.position.seconds : 0;
  const selectPath = (path: "video" | "transcript") => {
    if (path === "transcript") playerRef.current?.pause();
    setActivePath(path);
  };
  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "ArrowLeft" || event.key === "Home" ? "video" : "transcript";
    selectPath(next);
    document.getElementById(`lesson-${next}-tab`)?.focus();
  };
  return (
    <main className="member-page production-lesson-page">
      <header className="production-lesson-heading">
        <span className="micro-label">Academy lesson</span>
        <h1>{lesson.title}</h1>
        <p>{lesson.summary}</p>
      </header>
      <div className="production-lesson-workspace">
        <div className="production-lesson-main">
          <div aria-label="Lesson format" className="production-lesson-tabs" role="tablist">
            {(["video", "transcript"] as const).map((path) => (
              <button aria-controls={`lesson-${path}-panel`} aria-selected={activePath === path} id={`lesson-${path}-tab`} key={path} onClick={() => selectPath(path)} onKeyDown={handleTabKey} role="tab" tabIndex={activePath === path ? 0 : -1} type="button">
                {path === "video" ? "Video" : "Transcript"}
              </button>
            ))}
          </div>
          {playback.playbackStatus === "degraded" ? (
            <div className="production-video-degraded" role="status">
              <strong>Video is unavailable right now</strong>
              <p>{playback.reason.replaceAll("_", " ").toLowerCase()}. The transcript and practical materials remain available.</p>
              <button className="button button-secondary button-medium" onClick={() => selectPath("transcript")} type="button">Continue with transcript</button>
            </div>
          ) : null}
          <section aria-labelledby="lesson-video-tab" hidden={activePath !== "video"} id="lesson-video-panel" role="tabpanel">
            {playback.playbackStatus === "ready" ? (
              <MuxPlayer
                aria-label={`Video: ${lesson.title}`}
                autoPlay={false}
                className="production-mux-player"
                defaultHiddenCaptions={false}
                metadataVideoId={lesson.lessonVersionId}
                metadataVideoTitle={lesson.title}
                onLoadedMetadata={(event) => {
                  (event.currentTarget as unknown as { currentTime: number }).currentTime = resumeSeconds;
                }}
                onPause={(event) => {
                  if (!videoPlayed.current || !videoDirty.current) return;
                  videoPlayed.current = false;
                  void saveResume("video", {
                    seconds: Math.floor((event.currentTarget as unknown as { currentTime: number }).currentTime),
                  }).finally(() => { videoDirty.current = false; });
                }}
                onPlay={() => {
                  videoPlayed.current = true;
                  setUsedPaths((current) => new Set([...current, "video"]));
                  if (playback.playbackStatus === "ready" && Date.now() >= new Date(playback.mux.refreshAfter).getTime()) void refreshPlayback();
                }}
                onTimeUpdate={(event) => {
                  const seconds = Math.floor((event.currentTarget as unknown as { currentTime: number }).currentTime);
                  if (videoPlayed.current && seconds !== resumeSeconds) videoDirty.current = true;
                }}
                playbackId={playback.mux.playbackId}
                ref={playerRef as never}
                startTime={resumeSeconds}
                title={lesson.title}
                tokens={{
                  playback: playback.mux.playbackToken,
                  ...(playback.mux.thumbnailToken ? { thumbnail: playback.mux.thumbnailToken } : {}),
                  ...(playback.mux.storyboardToken ? { storyboard: playback.mux.storyboardToken } : {}),
                }}
              />
            ) : <p>Video unavailable. Continue with the transcript.</p>}
          </section>
          <section aria-labelledby="lesson-transcript-tab" hidden={activePath !== "transcript"} id="lesson-transcript-panel" role="tabpanel">
            <div className="production-transcript" role="document">
              {lesson.transcript.blocks.map((block) => (
                <article id={`transcript-${block.blockId}`} key={block.blockId}>
                  <p>{block.text}</p>
                  <button disabled={saving || progress?.state === "completed"} onClick={() => void saveResume("transcript", { blockId: block.blockId })} type="button">
                    Save position at {block.text}
                  </button>
                </article>
              ))}
            </div>
          </section>
          <div className="production-lesson-body">
            {lesson.blocks.map((block) => <LessonContentBlock block={block} key={block.blockId} />)}
          </div>
          <section aria-labelledby="lesson-resources-title" className="production-resources">
            <h2 id="lesson-resources-title">Lesson resources</h2>
            {lesson.resources.length === 0 ? <p>No resources are attached to this lesson.</p> : (
              <ul>{lesson.resources.map((resource) => (
                <li key={resource.id}><div><strong>{resource.label}</strong><span>{resource.mime === "application/pdf" ? "PDF" : resource.mime} · {byteSize(resource.byteSize)}</span></div><span className="production-resource-unavailable">{resource.availability === "preparing" ? "Preparing for delivery" : resource.availability === "deleted" ? "Resource removed" : "Download unavailable in this release"}</span></li>
              ))}</ul>
            )}
          </section>
        </div>
        <aside className="production-lesson-rail">
          <span className="micro-label">Your progress</span>
          <h2>{completionState === "complete" ? "Lesson completed" : "Ready to apply this?"}</h2>
          <p>{completionState === "complete" ? "Your immutable completion is recorded." : "Use either the video or transcript, then record completion."}</p>
          {completionState !== "complete" ? (
            <button className="button button-primary button-medium" disabled={completionState === "saving"} onClick={() => void completeLesson()} type="button">
              {completionState === "saving" ? "Recording…" : completionState === "failed" ? "Retry completion" : "Mark lesson complete"}
            </button>
          ) : null}
          <div aria-live="polite" className="production-save-status">
            {saving ? "Saving your place…" : completionState === "saving" ? "Recording completion…" : completionState === "complete" ? "Lesson completed" : completionState === "failed" ? "Completion not recorded. Retry when ready." : null}
          </div>
          {resumeFailed ? (
            <div className="production-unsynced" role="status">
              <span>Progress not saved.</span>
              <button disabled={saving} onClick={() => { if (pendingResume.current) void submitResume(pendingResume.current); }} type="button">Retry save</button>
            </div>
          ) : null}
          {lesson.previousRequiredLessonId ? <Link href={`/learn/course/${lesson.previousRequiredLessonId}`}>Previous lesson</Link> : null}
          {nextLessonId ? <Link href={`/learn/course/${nextLessonId}`}>Next lesson</Link> : null}
        </aside>
      </div>
    </main>
  );
}
