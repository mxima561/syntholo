"use client";

import {
  AttachLessonMediaResponseSchema,
  CourseDraftResponseSchema,
  CourseDraftTreeResponseSchema,
  CourseDraftUpdateResponseSchema,
  CourseListResponseSchema,
  CreateLessonUploadResponseSchema,
  EnrollmentGrantResponseSchema,
  LessonDraftResponseSchema,
  LessonReviewResponseSchema,
  StageDraftResponseSchema,
} from "@syntholo/contracts/content";
import { StaffAccountListResponseSchema } from "@syntholo/contracts/staff";
import { ApiErrorSchema } from "@syntholo/contracts/http";
import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import { createStaffApiClient } from "@/lib/api/client";

type CourseSummary = Readonly<{
  courseId: string; slug: string; title: string; description: string;
  revision: number; published: boolean; createdAt: string; enrolledCount: number;
}>;

type Status = "idle" | "submitting" | "invalid" | "failed" | "success";

type Stage = Readonly<{
  stageId: string; slug: string; title: string; order: number;
}>;

type LessonRow = Readonly<{
  lessonId: string; slug: string; title: string; summary: string; durationSeconds: number;
  order: number; revision: number; reviewed: boolean; published: boolean;
  body: string; action: string;
}>;

type AccountOption = Readonly<{
  accountId: string; accountName: string; ownerEmail: string | null;
}>;

type LessonBlock = Readonly<{
  type: string;
  blockId?: string;
  document?: Readonly<{ content?: readonly Readonly<{ content?: readonly Readonly<{ text?: string }>[] }>[] }>;
  instructions?: string;
}>;

function intentKey(scope: string): string {
  return `${scope}-${globalThis.crypto.randomUUID()}`;
}

async function readErrorCode(response: Response): Promise<string | null> {
  if (!/^application\/json(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) return null;
  try {
    const parsed = ApiErrorSchema.safeParse(await response.clone().json());
    return parsed.success ? parsed.data.error.code : null;
  } catch {
    return null;
  }
}

async function describeFailure(response: Response): Promise<string> {
  const code = await readErrorCode(response);
  return code === null ? `HTTP ${response.status}` : `${code} (HTTP ${response.status})`;
}

async function parseJson<T>(
  response: Response,
  schema: { safeParse(data: unknown): { success: true; data: T } | { success: false } },
): Promise<T | null> {
  if (!/^application\/json(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) return null;
  try {
    const parsed = schema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function putFileToUploadUrl(url: string, file: File, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(file);
  });
}

function buildBlocks(actionInstructions: string, bodyText: string) {
  return [
    {
      type: "rich_text",
      blockId: "body",
      document: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: bodyText }] }],
      },
    },
    {
      type: "action",
      blockId: "act",
      title: "Apply what you learned",
      instructions: actionInstructions,
    },
  ];
}

function buildTranscript(bodyText: string) {
  return { schemaVersion: 1, blocks: [{ blockId: "t1", text: bodyText }] };
}

function asBlock(value: unknown): LessonBlock | null {
  if (typeof value !== "object" || value === null || !("type" in value) || typeof value.type !== "string") return null;
  return value as LessonBlock;
}

function extractBody(blocks: readonly unknown[]): string {
  const rich = blocks.map(asBlock).find((block) => block?.type === "rich_text");
  return rich?.document?.content?.[0]?.content?.[0]?.text ?? "";
}

function extractAction(blocks: readonly unknown[]): string {
  const action = blocks.map(asBlock).find((block) => block?.type === "action");
  return action?.instructions ?? "";
}

export function ProductionContentAuthoring() {
  const api = createStaffApiClient();

  const [existingCourses, setExistingCourses] = useState<readonly CourseSummary[] | null>(null);
  const [existingCoursesError, setExistingCoursesError] = useState<string | null>(null);
  const [loadCourseError, setLoadCourseError] = useState<string | null>(null);

  async function refreshExistingCourses(): Promise<void> {
    try {
      const response = await api("/v1/staff/content/courses", { method: "GET" });
      if (!response.ok) {
        setExistingCoursesError(await describeFailure(response));
        return;
      }
      const body = await parseJson(response, CourseListResponseSchema);
      if (body === null) {
        setExistingCoursesError("Invalid course list");
        return;
      }
      setExistingCourses(body.courses);
    } catch {
      setExistingCoursesError("Network error");
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await api("/v1/staff/content/courses", { method: "GET" });
        if (cancelled) return;
        if (!response.ok) {
          setExistingCoursesError(await describeFailure(response));
          return;
        }
        const body = await parseJson(response, CourseListResponseSchema);
        if (body === null) {
          setExistingCoursesError("Invalid course list");
          return;
        }
        setExistingCourses(body.courses);
      } catch {
        if (!cancelled) setExistingCoursesError("Network error");
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [courseStatus, setCourseStatus] = useState<Status>("idle");
  const [courseErrorDetail, setCourseErrorDetail] = useState<string | null>(null);
  const [courseId, setCourseId] = useState<string | null>(null);
  const [courseRevision, setCourseRevision] = useState<number | null>(null);
  const [courseEditOpen, setCourseEditOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const [stages, setStages] = useState<readonly Stage[]>([]);
  const [stageStatus, setStageStatus] = useState<Status>("idle");
  const [stageErrorDetail, setStageErrorDetail] = useState<string | null>(null);
  const [stageSlug, setStageSlug] = useState("");
  const [stageTitle, setStageTitle] = useState("");
  const [stageOrder, setStageOrder] = useState("1");
  const [editingStageId, setEditingStageId] = useState<string | null>(null);

  const [selectedStageId, setSelectedStageId] = useState<string>("");
  const [lessons, setLessons] = useState<Record<string, LessonRow[]>>({});
  const [lessonStatus, setLessonStatus] = useState<Status>("idle");
  const [lessonErrorDetail, setLessonErrorDetail] = useState<string | null>(null);
  const [lessonSlug, setLessonSlug] = useState("");
  const [lessonTitle, setLessonTitle] = useState("");
  const [lessonSummary, setLessonSummary] = useState("");
  const [lessonDuration, setLessonDuration] = useState("360");
  const [lessonOrder, setLessonOrder] = useState("1");
  const [lessonBody, setLessonBody] = useState("");
  const [lessonAction, setLessonAction] = useState("");
  const [editingLessonId, setEditingLessonId] = useState<string | null>(null);

  const [uploadTargetLessonId, setUploadTargetLessonId] = useState<string | null>(null);
  const [uploadStage, setUploadStage] = useState<"idle" | "requesting" | "uploading" | "finalizing" | "done" | "failed">("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadErrorDetail, setUploadErrorDetail] = useState<string | null>(null);

  const [previewStatus, setPreviewStatus] = useState<Status>("idle");
  const [previewErrorDetail, setPreviewErrorDetail] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [manifestHash, setManifestHash] = useState<string | null>(null);
  const [publicationIssueCount, setPublicationIssueCount] = useState<number | null>(null);
  const [publishStatus, setPublishStatus] = useState<Status>("idle");
  const [publishErrorDetail, setPublishErrorDetail] = useState<string | null>(null);

  const [accounts, setAccounts] = useState<readonly AccountOption[]>([]);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [enrollAccountId, setEnrollAccountId] = useState("");
  const [enrollReason, setEnrollReason] = useState("Local admin grant.");
  const [enrollStatus, setEnrollStatus] = useState<Status>("idle");
  const [enrollErrorDetail, setEnrollErrorDetail] = useState<string | null>(null);

  useEffect(() => {
    if (courseId === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await api("/v1/staff/accounts", { method: "GET" });
        if (cancelled) return;
        if (!response.ok) {
          setAccountsError(await describeFailure(response));
          return;
        }
        const body = await parseJson(response, StaffAccountListResponseSchema);
        if (body === null) {
          setAccountsError("Invalid account list");
          return;
        }
        setAccounts(body.accounts);
      } catch {
        if (!cancelled) setAccountsError("Network error");
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  function resetAuthoringState(): void {
    setStages([]); setLessons({}); setSelectedStageId("");
    setEditingStageId(null); setEditingLessonId(null);
    setPreviewId(null); setManifestHash(null); setPublicationIssueCount(null);
    setPreviewStatus("idle"); setPublishStatus("idle");
    setEnrollStatus("idle"); setEnrollAccountId("");
    setCourseEditOpen(false);
  }

  async function createCourse(): Promise<void> {
    setCourseStatus("submitting");
    setCourseErrorDetail(null);
    try {
      const response = await api("/v1/staff/content/courses", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": intentKey("course"), "x-syntholo-csrf": "1" },
        body: JSON.stringify({ slug, title, description }),
      });
      if (!response.ok) {
        const code = await readErrorCode(response);
        setCourseErrorDetail(code === null ? `HTTP ${response.status}` : `${code} (HTTP ${response.status})`);
        setCourseStatus(code === "VALIDATION_ERROR" ? "invalid" : "failed");
        return;
      }
      const body = await parseJson(response, CourseDraftResponseSchema);
      if (body === null) {
        setCourseErrorDetail("Invalid course response");
        setCourseStatus("failed");
        return;
      }
      setCourseId(body.courseId);
      setCourseRevision(body.revision);
      setCourseStatus("success");
      void refreshExistingCourses();
    } catch (error) {
      setCourseErrorDetail(error instanceof Error ? error.message : "Network error");
      setCourseStatus("failed");
    }
  }

  async function updateCourseDetails(): Promise<void> {
    if (courseId === null || courseRevision === null) return;
    setCourseStatus("submitting");
    setCourseErrorDetail(null);
    try {
      const response = await api(`/v1/staff/content/courses/${courseId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "idempotency-key": intentKey("course-update"), "x-syntholo-csrf": "1" },
        body: JSON.stringify({ expectedRevision: courseRevision, title, description }),
      });
      if (!response.ok) {
        const code = await readErrorCode(response);
        setCourseErrorDetail(code === null ? `HTTP ${response.status}` : `${code} (HTTP ${response.status})`);
        setCourseStatus(code === "VALIDATION_ERROR" ? "invalid" : "failed");
        return;
      }
      const body = await parseJson(response, CourseDraftUpdateResponseSchema);
      if (body === null) {
        setCourseErrorDetail("Invalid course response");
        setCourseStatus("failed");
        return;
      }
      setCourseRevision(body.revision);
      setCourseStatus("success");
      void refreshExistingCourses();
    } catch (error) {
      setCourseErrorDetail(error instanceof Error ? error.message : "Network error");
      setCourseStatus("failed");
    }
  }

  async function editCourse(course: CourseSummary): Promise<void> {
    setLoadCourseError(null);
    try {
      const response = await api(`/v1/staff/content/courses/${course.courseId}`, { method: "GET" });
      if (!response.ok) {
        setLoadCourseError(await describeFailure(response));
        return;
      }
      const body = await parseJson(response, CourseDraftTreeResponseSchema);
      if (body === null) {
        setLoadCourseError("Invalid course draft");
        return;
      }
      resetAuthoringState();
      setCourseId(body.courseId);
      setCourseRevision(body.revision);
      setSlug(body.slug);
      setTitle(body.title);
      setDescription(body.description);
      setCourseStatus("success");
      setStages(body.stages.map((stage) => ({
        stageId: stage.stageId, slug: stage.slug, title: stage.title, order: stage.order,
      })));
      const grouped: Record<string, LessonRow[]> = {};
      for (const stage of body.stages) {
        grouped[stage.stageId] = stage.lessons.map((lesson) => ({
          lessonId: lesson.lessonId, slug: lesson.slug, title: lesson.title, summary: lesson.summary,
          durationSeconds: lesson.durationSeconds, order: lesson.order, revision: lesson.revision,
          reviewed: false, published: false,
          body: extractBody(lesson.blocks), action: extractAction(lesson.blocks),
        }));
      }
      setLessons(grouped);
    } catch (error) {
      setLoadCourseError(error instanceof Error ? error.message : "Network error");
    }
  }

  function editStage(stage: Stage): void {
    setEditingStageId(stage.stageId);
    setStageSlug(stage.slug);
    setStageTitle(stage.title);
    setStageOrder(String(stage.order));
  }

  async function saveStage(): Promise<void> {
    if (courseId === null || courseRevision === null) return;
    setStageStatus("submitting");
    try {
      const isEdit = editingStageId !== null;
      const url = isEdit
        ? `/v1/staff/content/courses/${courseId}/stages/${editingStageId}`
        : `/v1/staff/content/courses/${courseId}/stages`;
      const response = await api(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "content-type": "application/json", "idempotency-key": intentKey("stage"), "x-syntholo-csrf": "1" },
        body: JSON.stringify({
          expectedCourseRevision: courseRevision,
          slug: stageSlug, title: stageTitle, description: `Stage: ${stageTitle}.`,
          order: Number(stageOrder),
        }),
      });
      if (!response.ok) {
        const code = await readErrorCode(response);
        setStageErrorDetail(code === null ? `HTTP ${response.status}` : `${code} (HTTP ${response.status})`);
        setStageStatus(code === "VALIDATION_ERROR" ? "invalid" : "failed");
        return;
      }
      const body = await parseJson(response, StageDraftResponseSchema);
      if (body === null) {
        setStageErrorDetail("Invalid stage response");
        setStageStatus("failed");
        return;
      }
      if (isEdit) {
        setStages((current) => current.map((stage) => (
          stage.stageId === editingStageId
            ? { stageId: stage.stageId, slug: body.slug, title: body.title, order: body.order }
            : stage
        )));
      } else {
        setStages((current) => [...current, { stageId: body.stageId, slug: body.slug, title: body.title, order: body.order }]);
      }
      setStageSlug(""); setStageTitle(""); setEditingStageId(null);
      setStageStatus("success");
    } catch (error) {
      setStageErrorDetail(error instanceof Error ? error.message : "Network error");
      setStageStatus("failed");
    }
  }

  function editLesson(stageId: string, row: LessonRow): void {
    setSelectedStageId(stageId);
    setEditingLessonId(row.lessonId);
    setLessonSlug(row.slug);
    setLessonTitle(row.title);
    setLessonSummary(row.summary);
    setLessonDuration(String(row.durationSeconds));
    setLessonOrder(String(row.order));
    setLessonBody(row.body);
    setLessonAction(row.action);
  }

  async function saveLesson(): Promise<void> {
    if (courseId === null || selectedStageId === "") return;
    setLessonStatus("submitting");
    try {
      const isEdit = editingLessonId !== null;
      const url = isEdit
        ? `/v1/staff/content/courses/${courseId}/stages/${selectedStageId}/lessons/${editingLessonId}`
        : `/v1/staff/content/courses/${courseId}/stages/${selectedStageId}/lessons`;
      const response = await api(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "content-type": "application/json", "idempotency-key": intentKey("lesson"), "x-syntholo-csrf": "1" },
        body: JSON.stringify({
          stageId: selectedStageId,
          slug: lessonSlug, title: lessonTitle, summary: lessonSummary,
          durationSeconds: Number(lessonDuration),
          blocks: buildBlocks(lessonAction, lessonBody),
          transcript: buildTranscript(lessonBody),
          order: Number(lessonOrder), required: true,
        }),
      });
      if (!response.ok) {
        const code = await readErrorCode(response);
        setLessonErrorDetail(code === null ? `HTTP ${response.status}` : `${code} (HTTP ${response.status})`);
        setLessonStatus(code === "VALIDATION_ERROR" ? "invalid" : "failed");
        return;
      }
      const body = await parseJson(response, LessonDraftResponseSchema);
      if (body === null) {
        setLessonErrorDetail("Invalid lesson response");
        setLessonStatus("failed");
        return;
      }
      const row: LessonRow = {
        lessonId: body.lessonId, slug: body.slug, title: lessonTitle, summary: lessonSummary,
        durationSeconds: Number(lessonDuration), order: body.order, revision: body.revision,
        reviewed: false, published: false, body: lessonBody, action: lessonAction,
      };
      setLessons((current) => ({
        ...current,
        [selectedStageId]: isEdit
          ? (current[selectedStageId] ?? []).map((existing) => (existing.lessonId === editingLessonId ? row : existing))
          : [...(current[selectedStageId] ?? []), row],
      }));
      setLessonSlug(""); setLessonTitle(""); setLessonSummary(""); setLessonBody(""); setLessonAction(""); setEditingLessonId(null);
      setLessonStatus("success");
    } catch (error) {
      setLessonErrorDetail(error instanceof Error ? error.message : "Network error");
      setLessonStatus("failed");
    }
  }

  function updateLesson(stageId: string, lessonId: string, patch: Partial<LessonRow>): void {
    setLessons((current) => ({
      ...current,
      [stageId]: (current[stageId] ?? []).map((row) => (row.lessonId === lessonId ? { ...row, ...patch } : row)),
    }));
  }

  async function uploadLessonVideo(stageId: string, row: LessonRow, file: File): Promise<void> {
    setUploadTargetLessonId(row.lessonId);
    setUploadStage("requesting");
    setUploadProgress(0);
    setUploadErrorDetail(null);
    try {
      const createResponse = await api(`/v1/staff/content/lessons/${row.lessonId}/uploads`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": intentKey("lesson-upload"), "x-syntholo-csrf": "1" },
        body: JSON.stringify({}),
      });
      if (!createResponse.ok) {
        setUploadErrorDetail(await describeFailure(createResponse));
        setUploadStage("failed");
        return;
      }
      const created = await parseJson(createResponse, CreateLessonUploadResponseSchema);
      if (created === null) {
        setUploadErrorDetail("Invalid upload response");
        setUploadStage("failed");
        return;
      }
      setUploadStage("uploading");
      await putFileToUploadUrl(created.url, file, setUploadProgress);
      setUploadStage("finalizing");
      const finalizeResponse = await api(`/v1/staff/content/lessons/${row.lessonId}/uploads/${created.uploadId}/finalize`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-syntholo-csrf": "1" },
        body: JSON.stringify({ expectedRevision: row.revision }),
      });
      if (!finalizeResponse.ok) {
        setUploadErrorDetail(await describeFailure(finalizeResponse));
        setUploadStage("failed");
        return;
      }
      const finalized = await parseJson(finalizeResponse, AttachLessonMediaResponseSchema);
      if (finalized === null) {
        setUploadErrorDetail("Invalid finalize response");
        setUploadStage("failed");
        return;
      }
      updateLesson(stageId, row.lessonId, { revision: finalized.revision, reviewed: false, published: false });
      setUploadStage("done");
    } catch (error) {
      setUploadErrorDetail(error instanceof Error ? error.message : "Network error");
      setUploadStage("failed");
    }
  }

  async function reviewLesson(stageId: string, row: LessonRow): Promise<void> {
    setLessonErrorDetail(null);
    try {
      const response = await api(`/v1/staff/content/lessons/${row.lessonId}/review`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-syntholo-csrf": "1" },
        body: JSON.stringify({ expectedRevision: row.revision, reason: "Local dev stub review." }),
      });
      if (!response.ok) {
        setLessonErrorDetail(await describeFailure(response));
        setLessonStatus("failed");
        return;
      }
      if (await parseJson(response, LessonReviewResponseSchema) === null) {
        setLessonErrorDetail("Invalid review response");
        setLessonStatus("failed");
        return;
      }
      updateLesson(stageId, row.lessonId, { reviewed: true });
    } catch (error) {
      setLessonErrorDetail(error instanceof Error ? error.message : "Network error");
      setLessonStatus("failed");
    }
  }

  async function publishLesson(stageId: string, row: LessonRow): Promise<void> {
    setLessonErrorDetail(null);
    try {
      const response = await api(`/v1/staff/content/lessons/${row.lessonId}/publications`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": intentKey("publish-lesson"), "x-syntholo-csrf": "1" },
        body: JSON.stringify({ expectedVersion: row.revision, reason: `Publishing ${row.slug}.` }),
      });
      if (!response.ok) {
        setLessonErrorDetail(await describeFailure(response));
        setLessonStatus("failed");
        return;
      }
      updateLesson(stageId, row.lessonId, { published: true });
    } catch (error) {
      setLessonErrorDetail(error instanceof Error ? error.message : "Network error");
      setLessonStatus("failed");
    }
  }

  async function createPreview(): Promise<void> {
    if (courseId === null || courseRevision === null) return;
    setPreviewStatus("submitting");
    try {
      const response = await api(`/v1/staff/content/courses/${courseId}/previews`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": intentKey("preview"), "x-syntholo-csrf": "1" },
        body: JSON.stringify({ expectedVersion: courseRevision, reason: "Course preview." }),
      });
      if (!response.ok) {
        setPreviewErrorDetail(await describeFailure(response));
        setPreviewStatus("failed");
        return;
      }
      const body = await response.json() as { previewId: string; manifestHash: string; publicationIssues: readonly unknown[] };
      setPreviewId(body.previewId);
      setManifestHash(body.manifestHash);
      setPublicationIssueCount(body.publicationIssues.length);
      setPreviewStatus("success");
    } catch (error) {
      setPreviewErrorDetail(error instanceof Error ? error.message : "Network error");
      setPreviewStatus("failed");
    }
  }

  async function publishCourse(): Promise<void> {
    if (courseId === null || previewId === null || manifestHash === null) return;
    setPublishStatus("submitting");
    try {
      const response = await api(`/v1/staff/content/courses/${courseId}/publications`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": intentKey("publish-course"), "x-syntholo-csrf": "1" },
        body: JSON.stringify({ previewId, expectedManifestHash: manifestHash, expectedHeadRevision: 0, reason: "Publishing course." }),
      });
      if (!response.ok) setPublishErrorDetail(await describeFailure(response));
      setPublishStatus(response.ok ? "success" : "failed");
      if (response.ok) void refreshExistingCourses();
    } catch (error) {
      setPublishErrorDetail(error instanceof Error ? error.message : "Network error");
      setPublishStatus("failed");
    }
  }

  async function grantEnrollment(): Promise<void> {
    if (courseId === null) return;
    setEnrollStatus("submitting");
    try {
      const response = await api("/v1/staff/learning/enrollments", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": intentKey("enroll"), "x-syntholo-csrf": "1" },
        body: JSON.stringify({ accountId: enrollAccountId, courseId, reason: enrollReason }),
      });
      if (!response.ok) {
        setEnrollErrorDetail(await describeFailure(response));
        setEnrollStatus("failed");
        return;
      }
      if (await parseJson(response, EnrollmentGrantResponseSchema) === null) {
        setEnrollErrorDetail("Invalid enrollment response");
        setEnrollStatus("failed");
        return;
      }
      setEnrollStatus("success");
      void refreshExistingCourses();
    } catch (error) {
      setEnrollErrorDetail(error instanceof Error ? error.message : "Network error");
      setEnrollStatus("failed");
    }
  }

  return (
    <div className="admin-page production-content-authoring">
      <section className="admin-page-head">
        <div>
          <span className="micro-label">Content authoring</span>
          <h1>Course content</h1>
          <p>Create or edit a course, its stages and lessons, publish them, and grant a member enrollment.</p>
        </div>
      </section>

      <section aria-labelledby="existing-courses-title">
        <h2 id="existing-courses-title">Existing courses</h2>
        {existingCourses === null && existingCoursesError === null ? <p>Loading…</p> : null}
        {existingCoursesError !== null ? <p role="alert">Could not load courses: {existingCoursesError}</p> : null}
        {loadCourseError !== null ? <p role="alert">Could not load the course for editing: {loadCourseError}</p> : null}
        {existingCourses !== null && existingCourses.length === 0 ? <p>No courses yet.</p> : null}
        {existingCourses !== null && existingCourses.length > 0 ? (
          <div className="admin-table">
            <header>
              <span>Course</span>
              <span>Slug</span>
              <span>Status</span>
              <span>Revision / enrolled</span>
              <span aria-hidden="true" />
            </header>
            {existingCourses.map((course) => (
              <div key={course.courseId}>
                <span><strong>{course.title}</strong></span>
                <span>{course.slug}</span>
                <span className={`status-pill ${course.published ? "live" : "paused"}`}>
                  {course.published ? "Published" : "Draft only"}
                </span>
                <span>Revision {course.revision} · {course.enrolledCount} enrolled</span>
                <span>
                  <button className="row-icon-button" onClick={() => void editCourse(course)} type="button">
                    <span aria-hidden="true">✎</span>
                    <span className="sr-only">Edit {course.title}</span>
                  </button>
                  {course.published ? <Link href="/learn/course">View on /learn</Link> : null}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="course-form-title">
        <h2 id="course-form-title">1. Course</h2>
        {courseId === null ? (
          <div className="content-authoring-form">
            <label>Slug<input onChange={(event) => setSlug(event.target.value)} value={slug} /></label>
            <label>Title<input onChange={(event) => setTitle(event.target.value)} value={title} /></label>
            <label>Description<textarea onChange={(event) => setDescription(event.target.value)} value={description} /></label>
            <button className="button button-primary button-medium" disabled={courseStatus === "submitting"} onClick={() => void createCourse()} type="button">Create course draft</button>
            {courseStatus === "invalid" ? <p role="alert">Check the slug/title/description.{courseErrorDetail ? ` (${courseErrorDetail})` : ""}</p> : null}
            {courseStatus === "failed" ? <p role="alert">Could not create the course.{courseErrorDetail ? ` (${courseErrorDetail})` : ""}</p> : null}
          </div>
        ) : !courseEditOpen ? (
          <div className="content-authoring-form">
            <p role="status">Course <code>{courseId}</code> (revision {courseRevision}).</p>
            <button className="button button-quiet button-medium" onClick={() => setCourseEditOpen(true)} type="button">Edit course details</button>
          </div>
        ) : (
          <div className="content-authoring-form">
            <p>Slug: {slug}</p>
            <label>Title<input onChange={(event) => setTitle(event.target.value)} value={title} /></label>
            <label>Description<textarea onChange={(event) => setDescription(event.target.value)} value={description} /></label>
            <button className="button button-primary button-medium" disabled={courseStatus === "submitting"} onClick={() => void updateCourseDetails().then(() => setCourseEditOpen(false))} type="button">Save course details</button>
            <button className="button button-quiet button-medium" onClick={() => setCourseEditOpen(false)} type="button">Cancel</button>
            {courseStatus === "invalid" ? <p role="alert">Check the title/description.{courseErrorDetail ? ` (${courseErrorDetail})` : ""}</p> : null}
            {courseStatus === "failed" ? <p role="alert">Could not save the course.{courseErrorDetail ? ` (${courseErrorDetail})` : ""}</p> : null}
          </div>
        )}
      </section>

      {courseId !== null ? (
        <section aria-labelledby="stage-form-title">
          <h2 id="stage-form-title">2. Stages</h2>
          <div className="content-editor-panel">
            <div className="content-stage-list">
              {stages.map((stage) => (
                <section key={stage.stageId}>
                  <div>
                    <span>{stage.order}</span>
                    <div>
                      <strong>{stage.title}</strong>
                      <small>Stage slug: {stage.slug}</small>
                    </div>
                    <button onClick={() => editStage(stage)} type="button">
                      <span aria-hidden="true">✎</span>
                      <span className="sr-only">Edit stage {stage.title}</span>
                    </button>
                  </div>
                  {(lessons[stage.stageId] ?? []).map((row) => (
                    <Fragment key={row.lessonId}>
                      <article>
                        <span>{row.order}</span>
                        <div>
                          <strong>{row.title}</strong>
                          <small>Lesson slug: {row.slug}</small>
                        </div>
                        <span className={`status-pill ${row.published ? "live" : row.reviewed ? "review" : "paused"}`}>
                          {row.published ? "Published" : row.reviewed ? "Reviewed" : "Draft"}
                        </span>
                        <button onClick={() => editLesson(stage.stageId, row)} type="button">
                          <span aria-hidden="true">✎</span>
                          <span className="sr-only">Edit lesson {row.title}</span>
                        </button>
                      </article>
                      <div className="lesson-actions">
                        <label>
                          Upload video
                          <input
                            accept="video/*"
                            disabled={uploadTargetLessonId === row.lessonId && uploadStage !== "done" && uploadStage !== "failed"}
                            onChange={(event) => {
                              const file = event.target.files?.[0];
                              event.target.value = "";
                              if (file) void uploadLessonVideo(stage.stageId, row, file);
                            }}
                            type="file"
                          />
                        </label>
                        {uploadTargetLessonId === row.lessonId ? (
                          <p role={uploadStage === "failed" ? "alert" : "status"}>
                            {uploadStage === "requesting" ? "Requesting upload URL…" : null}
                            {uploadStage === "uploading" ? `Uploading… ${uploadProgress}%` : null}
                            {uploadStage === "finalizing" ? "Registering with Mux…" : null}
                            {uploadStage === "done" ? "Uploaded — processing on Mux. Publish will report VIDEO_NOT_READY until it finishes; try again shortly." : null}
                            {uploadStage === "failed" ? `Upload failed.${uploadErrorDetail ? ` (${uploadErrorDetail})` : ""}` : null}
                          </p>
                        ) : null}
                        {!row.reviewed ? <button onClick={() => void reviewLesson(stage.stageId, row)} type="button">Record review</button> : null}
                        {row.reviewed && !row.published ? <button onClick={() => void publishLesson(stage.stageId, row)} type="button">Publish lesson</button> : null}
                      </div>
                    </Fragment>
                  ))}
                </section>
              ))}
            </div>
          </div>
          <div className="content-authoring-form">
            <label>Slug<input onChange={(event) => setStageSlug(event.target.value)} value={stageSlug} /></label>
            <label>Title<input onChange={(event) => setStageTitle(event.target.value)} value={stageTitle} /></label>
            <label>Order<input inputMode="numeric" onChange={(event) => setStageOrder(event.target.value)} value={stageOrder} /></label>
            <button className="button button-primary button-medium" disabled={stageStatus === "submitting"} onClick={() => void saveStage()} type="button">
              {editingStageId === null ? "Add stage" : "Save stage"}
            </button>
            {editingStageId !== null ? <button className="button button-quiet button-medium" onClick={() => { setEditingStageId(null); setStageSlug(""); setStageTitle(""); }} type="button">Cancel edit</button> : null}
            {stageStatus === "invalid" ? <p role="alert">Check the stage fields.{stageErrorDetail ? ` (${stageErrorDetail})` : ""}</p> : null}
            {stageStatus === "failed" ? <p role="alert">Could not save the stage.{stageErrorDetail ? ` (${stageErrorDetail})` : ""}</p> : null}
          </div>
        </section>
      ) : null}

      {courseId !== null && stages.length > 0 ? (
        <section aria-labelledby="lesson-form-title">
          <h2 id="lesson-form-title">3. Lessons</h2>
          <label>Stage
            <select onChange={(event) => setSelectedStageId(event.target.value)} value={selectedStageId}>
              <option value="">Select a stage</option>
              {stages.map((stage) => (<option key={stage.stageId} value={stage.stageId}>{stage.title}</option>))}
            </select>
          </label>
          {selectedStageId !== "" ? (
            <div className="content-authoring-form">
              <label>Slug<input onChange={(event) => setLessonSlug(event.target.value)} value={lessonSlug} /></label>
              <label>Title<input onChange={(event) => setLessonTitle(event.target.value)} value={lessonTitle} /></label>
              <label>Summary<input onChange={(event) => setLessonSummary(event.target.value)} value={lessonSummary} /></label>
              <label>Duration seconds (300-720)<input inputMode="numeric" onChange={(event) => setLessonDuration(event.target.value)} value={lessonDuration} /></label>
              <label>Order<input inputMode="numeric" onChange={(event) => setLessonOrder(event.target.value)} value={lessonOrder} /></label>
              <label>Lesson body<textarea onChange={(event) => setLessonBody(event.target.value)} value={lessonBody} /></label>
              <label>Action instructions<textarea onChange={(event) => setLessonAction(event.target.value)} value={lessonAction} /></label>
              <button className="button button-primary button-medium" disabled={lessonStatus === "submitting"} onClick={() => void saveLesson()} type="button">
                {editingLessonId === null ? "Add lesson" : "Save lesson"}
              </button>
              {editingLessonId !== null ? (
                <button className="button button-quiet button-medium" onClick={() => { setEditingLessonId(null); setLessonSlug(""); setLessonTitle(""); setLessonSummary(""); setLessonBody(""); setLessonAction(""); }} type="button">Cancel edit</button>
              ) : null}
              {lessonStatus === "invalid" ? <p role="alert">Check the lesson fields.{lessonErrorDetail ? ` (${lessonErrorDetail})` : ""}</p> : null}
              {lessonStatus === "failed" ? <p role="alert">Could not save the lesson.{lessonErrorDetail ? ` (${lessonErrorDetail})` : ""}</p> : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {courseId !== null ? (
        <section aria-labelledby="publish-title">
          <h2 id="publish-title">4. Preview &amp; publish course</h2>
          <button className="button button-quiet button-medium" disabled={previewStatus === "submitting"} onClick={() => void createPreview()} type="button">Create preview</button>
          {previewId !== null ? <p>Preview <code>{previewId}</code> — {publicationIssueCount} publication issue(s).</p> : null}
          {previewStatus === "failed" ? <p role="alert">Could not create the preview.{previewErrorDetail ? ` (${previewErrorDetail})` : ""}</p> : null}
          {previewId !== null && publicationIssueCount === 0 ? (
            <button className="button button-primary button-medium" disabled={publishStatus === "submitting"} onClick={() => void publishCourse()} type="button">Publish course</button>
          ) : null}
          {publishStatus === "success" ? <p role="status">Course published.</p> : null}
          {publishStatus === "failed" ? <p role="alert">Could not publish the course.{publishErrorDetail ? ` (${publishErrorDetail})` : ""}</p> : null}
        </section>
      ) : null}

      {courseId !== null ? (
        <section aria-labelledby="enroll-title">
          <h2 id="enroll-title">5. Grant enrollment</h2>
          <div className="content-authoring-form">
            <label>Account
              <select onChange={(event) => setEnrollAccountId(event.target.value)} value={enrollAccountId}>
                <option value="">Select an account</option>
                {accounts.map((account) => (
                  <option key={account.accountId} value={account.accountId}>
                    {account.accountName}{account.ownerEmail !== null ? ` — ${account.ownerEmail}` : ""}
                  </option>
                ))}
              </select>
            </label>
            {accountsError !== null ? <p role="alert">Could not load accounts: {accountsError}</p> : null}
            <label>Reason<input onChange={(event) => setEnrollReason(event.target.value)} value={enrollReason} /></label>
            <button className="button button-primary button-medium" disabled={enrollStatus === "submitting" || enrollAccountId === ""} onClick={() => void grantEnrollment()} type="button">Grant enrollment</button>
            {enrollStatus === "success" ? <p role="status">Enrollment granted.</p> : null}
            {enrollStatus === "failed" ? <p role="alert">Could not grant the enrollment.{enrollErrorDetail ? ` (${enrollErrorDetail})` : ""}</p> : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
