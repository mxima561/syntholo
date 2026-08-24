import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionContentAuthoring } from "./production-content-authoring";

afterEach(() => { vi.unstubAllGlobals(); });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("ProductionContentAuthoring", () => {
  it("walks course -> stage -> lesson -> review -> publish -> preview -> publish course -> enrollment", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      if (path === "/v1/staff/content/courses" && method === "GET") {
        return jsonResponse({ courses: [] });
      }
      if (path === "/v1/staff/content/courses" && method === "POST") {
        return jsonResponse({
          courseId: "10000000-0000-4000-8000-000000000010", slug: "ai-os-academy",
          title: "AI OS Academy", description: "Learn.", revision: 1, createdAt: "2026-08-14T16:00:00.000Z",
        }, 201);
      }
      if (path === "/v1/staff/content/courses/10000000-0000-4000-8000-000000000010/stages" && method === "POST") {
        return jsonResponse({
          stageId: "10000000-0000-4000-8000-000000000020", courseId: "10000000-0000-4000-8000-000000000010",
          slug: "diagnose", title: "Diagnose", description: "Stage: Diagnose.", order: 1, revision: 1,
        }, 201);
      }
      if (path === "/v1/staff/content/courses/10000000-0000-4000-8000-000000000010/stages/10000000-0000-4000-8000-000000000020/lessons" && method === "POST") {
        return jsonResponse({
          lessonId: "10000000-0000-4000-8000-000000000030", courseId: "10000000-0000-4000-8000-000000000010",
          stageId: "10000000-0000-4000-8000-000000000020", slug: "diagnose-1", revision: 1,
          mediaAssetId: "10000000-0000-4000-8000-000000000040", order: 1, required: true,
        }, 201);
      }
      if (path === "/v1/staff/content/lessons/10000000-0000-4000-8000-000000000030/review" && method === "POST") {
        return jsonResponse({
          lessonId: "10000000-0000-4000-8000-000000000030", draftRevision: 1, draftHash: "a".repeat(64),
          accessibilityDecisionId: "10000000-0000-4000-8000-000000000050", disclosureDecisionId: "10000000-0000-4000-8000-000000000051",
        }, 201);
      }
      if (path === "/v1/staff/content/lessons/10000000-0000-4000-8000-000000000030/publications" && method === "POST") {
        return jsonResponse({
          id: "10000000-0000-4000-8000-000000000060", lessonId: "10000000-0000-4000-8000-000000000030",
          courseId: "10000000-0000-4000-8000-000000000010", version: 1, contentHash: "b".repeat(64),
          publishedAt: "2026-08-14T16:00:00.000Z",
        }, 201);
      }
      if (path === "/v1/staff/content/courses/10000000-0000-4000-8000-000000000010/previews" && method === "POST") {
        return jsonResponse({
          previewId: "10000000-0000-4000-8000-000000000070", manifestHash: "c".repeat(64),
          manifest: { schemaVersion: 1, course: {}, stages: [] }, publicationIssues: [],
          createdAt: "2026-08-14T16:00:00.000Z",
        }, 201);
      }
      if (path === "/v1/staff/content/courses/10000000-0000-4000-8000-000000000010/publications" && method === "POST") {
        return jsonResponse({
          id: "10000000-0000-4000-8000-000000000080", courseId: "10000000-0000-4000-8000-000000000010",
          version: 1, manifestHash: "c".repeat(64), headRevision: 1, publishedAt: "2026-08-14T16:00:00.000Z",
        }, 201);
      }
      if (path === "/v1/staff/accounts" && method === "GET") {
        return jsonResponse({
          accounts: [{
            accountId: "10000000-0000-4000-8000-0000000000a0", accountName: "Test Account",
            ownerEmail: "owner@example.test", status: "active", enrolledCourseCount: 0,
          }],
        });
      }
      if (path === "/v1/staff/learning/enrollments" && method === "POST") {
        return jsonResponse({
          enrollmentId: "10000000-0000-4000-8000-000000000090", accountId: "10000000-0000-4000-8000-0000000000a0",
          courseId: "10000000-0000-4000-8000-000000000010", courseVersionId: "10000000-0000-4000-8000-000000000080",
          enrolledAt: "2026-08-14T16:00:00.000Z",
        }, 201);
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ProductionContentAuthoring />);

    fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "ai-os-academy" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "AI OS Academy" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Learn to run an AI-first agency." } });
    fireEvent.click(screen.getByRole("button", { name: "Create course draft" }));
    await screen.findByText("10000000-0000-4000-8000-000000000010");

    fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "diagnose" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Diagnose" } });
    fireEvent.click(screen.getByRole("button", { name: "Add stage" }));
    await waitFor(() => expect(screen.getByText("Stage slug: diagnose")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Stage"), { target: { value: "10000000-0000-4000-8000-000000000020" } });
    const lessonSection = screen.getByText("3. Lessons").closest("section") as HTMLElement;
    fireEvent.change(within(lessonSection).getByLabelText("Slug"), { target: { value: "diagnose-1" } });
    fireEvent.change(within(lessonSection).getByLabelText("Title"), { target: { value: "Diagnose 1" } });
    fireEvent.change(within(lessonSection).getByLabelText("Summary"), { target: { value: "Summary." } });
    fireEvent.change(within(lessonSection).getByLabelText("Duration seconds (300-720)"), { target: { value: "360" } });
    fireEvent.change(within(lessonSection).getByLabelText("Lesson body"), { target: { value: "Lesson body content." } });
    fireEvent.change(within(lessonSection).getByLabelText("Action instructions"), { target: { value: "Do the exercise." } });
    fireEvent.click(screen.getByRole("button", { name: "Add lesson" }));
    await waitFor(() => expect(screen.getByText("Draft")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Record review" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Publish lesson" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Publish lesson" }));
    await waitFor(() => expect(screen.getByText("Published")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Create preview" }));
    await waitFor(() => expect(screen.getByText(/0 publication issue/u)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Publish course" }));
    await screen.findByText("Course published.");

    await waitFor(() => expect(screen.getByLabelText("Account")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "10000000-0000-4000-8000-0000000000a0" } });
    fireEvent.click(screen.getByRole("button", { name: "Grant enrollment" }));
    await screen.findByText("Enrollment granted.");

    expect(fetcher).toHaveBeenCalledWith("/v1/staff/content/courses", expect.objectContaining({ method: "POST" }));
    expect(fetcher).toHaveBeenCalledWith("/v1/staff/learning/enrollments", expect.objectContaining({ method: "POST" }));
  });

  it("uploads a lesson video through the direct-upload routes and reports Mux processing", async () => {
    const lessonId = "10000000-0000-4000-8000-000000000030";
    const uploadId = "8UPhmY7NDK8sv74CGx5LToQHqQ82DkdA2VDVBNZdjtw";
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      if (path === "/v1/staff/content/courses" && method === "GET") return jsonResponse({ courses: [] });
      if (path === "/v1/staff/content/courses" && method === "POST") {
        return jsonResponse({
          courseId: "10000000-0000-4000-8000-000000000010", slug: "ai-os-academy",
          title: "AI OS Academy", description: "Learn.", revision: 1, createdAt: "2026-08-14T16:00:00.000Z",
        }, 201);
      }
      if (path === "/v1/staff/content/courses/10000000-0000-4000-8000-000000000010/stages" && method === "POST") {
        return jsonResponse({
          stageId: "10000000-0000-4000-8000-000000000020", courseId: "10000000-0000-4000-8000-000000000010",
          slug: "diagnose", title: "Diagnose", description: "Stage: Diagnose.", order: 1, revision: 1,
        }, 201);
      }
      if (path === "/v1/staff/content/courses/10000000-0000-4000-8000-000000000010/stages/10000000-0000-4000-8000-000000000020/lessons" && method === "POST") {
        return jsonResponse({
          lessonId, courseId: "10000000-0000-4000-8000-000000000010",
          stageId: "10000000-0000-4000-8000-000000000020", slug: "diagnose-1", revision: 1,
          mediaAssetId: "10000000-0000-4000-8000-000000000040", order: 1, required: true,
        }, 201);
      }
      if (path === `/v1/staff/content/lessons/${lessonId}/uploads` && method === "POST") {
        return jsonResponse({ uploadId, url: "https://storage.mux.com/upload/mock" }, 201);
      }
      if (path === `/v1/staff/content/lessons/${lessonId}/uploads/${uploadId}/finalize` && method === "POST") {
        return jsonResponse({
          lessonId, revision: 2, mediaAssetId: "10000000-0000-4000-8000-000000000099", mediaState: "waiting",
        });
      }
      if (path === "/v1/staff/accounts" && method === "GET") return jsonResponse({ accounts: [] });
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);

    class MockXhr {
      upload = { onprogress: null as ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      status = 200;
      open(): void {}
      send(): void {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
        this.onload?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXhr);

    render(<ProductionContentAuthoring />);

    fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "ai-os-academy" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "AI OS Academy" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Learn to run an AI-first agency." } });
    fireEvent.click(screen.getByRole("button", { name: "Create course draft" }));
    await screen.findByText("10000000-0000-4000-8000-000000000010");

    fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "diagnose" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Diagnose" } });
    fireEvent.click(screen.getByRole("button", { name: "Add stage" }));
    await waitFor(() => expect(screen.getByText("Stage slug: diagnose")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Stage"), { target: { value: "10000000-0000-4000-8000-000000000020" } });
    const lessonSection = screen.getByText("3. Lessons").closest("section") as HTMLElement;
    fireEvent.change(within(lessonSection).getByLabelText("Slug"), { target: { value: "diagnose-1" } });
    fireEvent.change(within(lessonSection).getByLabelText("Title"), { target: { value: "Diagnose 1" } });
    fireEvent.change(within(lessonSection).getByLabelText("Summary"), { target: { value: "Summary." } });
    fireEvent.change(within(lessonSection).getByLabelText("Duration seconds (300-720)"), { target: { value: "360" } });
    fireEvent.change(within(lessonSection).getByLabelText("Lesson body"), { target: { value: "Lesson body content." } });
    fireEvent.change(within(lessonSection).getByLabelText("Action instructions"), { target: { value: "Do the exercise." } });
    fireEvent.click(screen.getByRole("button", { name: "Add lesson" }));
    await waitFor(() => expect(screen.getByText("Draft")).toBeInTheDocument());

    const fileInput = screen.getByLabelText("Upload video") as HTMLInputElement;
    const file = new File(["fake-video-bytes"], "lesson.mp4", { type: "video/mp4" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await screen.findByText(/Uploaded — processing on Mux/u);
    expect(fetcher).toHaveBeenCalledWith(
      `/v1/staff/content/lessons/${lessonId}/uploads`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetcher).toHaveBeenCalledWith(
      `/v1/staff/content/lessons/${lessonId}/uploads/${uploadId}/finalize`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ expectedRevision: 1 }) }),
    );
  });

  it("loads an existing course for editing and PATCHes its title", async () => {
    const courseId = "10000000-0000-4000-8000-000000000010";
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      if (path === "/v1/staff/content/courses" && method === "GET") {
        return jsonResponse({
          courses: [{
            courseId, slug: "ai-os-academy", title: "AI OS Academy", description: "Learn.",
            revision: 1, published: true, createdAt: "2026-08-14T16:00:00.000Z", enrolledCount: 3,
          }],
        });
      }
      if (path === `/v1/staff/content/courses/${courseId}` && method === "GET") {
        return jsonResponse({
          courseId, slug: "ai-os-academy", title: "AI OS Academy", description: "Learn.", revision: 1,
          stages: [{
            stageId: "10000000-0000-4000-8000-000000000020", slug: "diagnose", title: "Diagnose",
            description: "Stage.", order: 1, revision: 1,
            lessons: [{
              lessonId: "10000000-0000-4000-8000-000000000030", slug: "diagnose-1", title: "Diagnose 1",
              summary: "Summary.", durationSeconds: 360, order: 1, required: true, revision: 1,
              blocks: [
                { type: "rich_text", blockId: "body", document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Body text." }] }] } },
                { type: "action", blockId: "act", title: "Apply", instructions: "Do it." },
              ],
              transcript: { schemaVersion: 1, blocks: [] },
            }],
          }],
        });
      }
      if (path === `/v1/staff/content/courses/${courseId}` && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { title: string; description: string; expectedRevision: number };
        return jsonResponse({ courseId, title: body.title, description: body.description, revision: body.expectedRevision + 1 });
      }
      if (path === "/v1/staff/accounts" && method === "GET") {
        return jsonResponse({ accounts: [] });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ProductionContentAuthoring />);

    await screen.findByText("AI OS Academy");
    fireEvent.click(screen.getByRole("button", { name: "Edit AI OS Academy" }));
    await screen.findByText("Stage slug: diagnose");
    expect(screen.getByText(/Lesson slug: diagnose-1/u)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit course details" }));
    const courseSection = screen.getByText("1. Course").closest("section") as HTMLElement;
    fireEvent.change(within(courseSection).getByLabelText("Title"), { target: { value: "AI OS Academy (updated)" } });
    fireEvent.click(within(courseSection).getByRole("button", { name: "Save course details" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      `/v1/staff/content/courses/${courseId}`,
      expect.objectContaining({ method: "PATCH" }),
    ));
  });
});
