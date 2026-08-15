import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

const accountId = "10000000-0000-4000-8000-000000000001";
const courseId = "10000000-0000-4000-8000-000000000041";
const lessonId = "10000000-0000-4000-8000-000000000042";
const lessonVersionId = "10000000-0000-4000-8000-000000000043";

const unavailable = {
  learning: { state: "unavailable", reason: "module_not_implemented" },
  support: { state: "unavailable", reason: "module_not_implemented" },
  sessions: { state: "unavailable", reason: "module_not_implemented" },
  implementation: { state: "unavailable", reason: "module_not_implemented" },
  recommendations: { state: "unavailable", reason: "module_not_implemented" },
} as const;

const empty = {
  learning: { state: "empty", reason: "no_required_lesson" },
  support: { state: "empty", reason: "no_customer_response_due" },
  sessions: { state: "empty", reason: "no_session_within_48_hours" },
  implementation: { state: "empty", reason: "no_incomplete_artifact_or_feedback" },
  recommendations: { state: "empty", reason: "no_optional_recommendation" },
} as const;

function access(academyCourse: boolean) {
  const grantId = "20000000-0000-4000-8000-000000000001";
  return {
    accountId,
    capabilities: {
      academy_course: academyCourse,
      support: false,
      circle_write: false,
      operator_club: false,
      business_os: false,
    },
    holds: [],
    seatLimit: 3,
    reservedSeats: 1,
    explanations: [
      { capability: "academy_course", sourceGrantIds: academyCourse ? [grantId] : [] },
      { capability: "support", sourceGrantIds: [] },
      { capability: "circle_write", sourceGrantIds: [] },
      { capability: "operator_club", sourceGrantIds: [] },
      { capability: "business_os", sourceGrantIds: [] },
    ],
  };
}

function dashboard(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-14T16:00:00.000Z",
    account: { id: accountId, name: "Acme Advisory" },
    access: access(false),
    experience: { state: "access_required" },
    projections: unavailable,
    nextBestStep: {
      kind: "access_blocker",
      reason: "academy_course_required",
      target: "program_options",
    },
    ...overrides,
  };
}

function dashboardV2(overrides: Record<string, unknown> = {}) {
  const course = {
    schemaVersion: 1,
    enrollmentId: "10000000-0000-4000-8000-000000000044",
    course: {
      id: courseId,
      versionId: "10000000-0000-4000-8000-000000000045",
      title: "Syntholo Academy",
      description: "The implementation course.",
    },
    stages: [{
      id: "10000000-0000-4000-8000-000000000046",
      title: "Diagnose",
      order: 1,
      lessons: [{
        id: lessonId,
        lessonVersionId,
        order: 1,
        required: true,
        title: "Map the constraint",
        summary: "Name the bottleneck before changing the system.",
        durationSeconds: 600,
        releaseRule: { kind: "immediate" },
        availability: "available",
        availableAt: "2026-08-14T16:00:00.000Z",
        progress: "not_started",
      }],
    }],
    progress: { completedRequired: 0, requiredTotal: 18, percent: 0 },
  } as const;
  return {
    schemaVersion: 2,
    generatedAt: "2026-08-14T16:00:00.000Z",
    account: { id: accountId, name: "Acme Advisory" },
    access: access(true),
    experience: { state: "ready" },
    learning: { state: "available", course },
    nextBestStep: {
      kind: "lesson",
      reason: "next_required_lesson",
      target: { courseId, lessonId },
    },
    ...overrides,
  };
}

const implementationArtifacts = {
  schemaVersion: 1,
  items: ["readiness_map", "ai_policy", "workflow_portfolio", "enablement_checklist", "roadmap"]
    .map((kind, index) => ({
      id: `30000000-0000-4000-8000-00000000000${index + 1}`,
      kind,
      title: ["Readiness map", "AI policy", "Workflow portfolio", "Enablement checklist", "90-day roadmap"][index],
      currentVersion: 0,
      currentState: null,
      currentVersionId: null,
      updatedAt: null,
      authorLabel: null,
    })),
  nextCursor: null,
  implementationCompletion: { completed: false, completedAt: null },
} as const;

describe("member dashboard contract", () => {
  it("resolves only through the narrow package export used by the production web client", async () => {
    const packageJson = JSON.parse(await readFile(
      new URL("../package.json", import.meta.url),
      "utf8",
    )) as { exports: Record<string, string> };
    const webClient = await readFile(
      new URL("../../../apps/web/src/components/production-member-dashboard.tsx", import.meta.url),
      "utf8",
    );

    expect(packageJson.exports["./member-dashboard"]).toBe("./src/member-dashboard.ts");
    expect(webClient).toContain('from "@syntholo/contracts/member-dashboard"');
    expect(webClient).not.toMatch(/from ["']@syntholo\/contracts["']/u);
    expect(webClient).not.toMatch(/(?:lib\/demo|features\/dashboard)/u);
  });

  it("publishes the narrow v1 schema and canonical account-name writer", async () => {
    const contract = await import("./member-dashboard.js");

    expect(contract.canonicalizeAccountName("  Cafe\u0301  ")).toBe("Café");
    expect(contract.MemberDashboardResponseSchema.parse(dashboard()).schemaVersion).toBe(1);
  });

  it("publishes a strict v2 learning projection with a server-selected next lesson", async () => {
    const { MemberDashboardV2ResponseSchema } = await import("./member-dashboard.js");
    expect(MemberDashboardV2ResponseSchema.parse(dashboardV2())).toMatchObject({
      schemaVersion: 2,
      experience: { state: "ready" },
      nextBestStep: { kind: "lesson", target: { courseId, lessonId } },
    });
    expect(MemberDashboardV2ResponseSchema.safeParse(dashboardV2({
      nextBestStep: {
        kind: "lesson",
        reason: "next_required_lesson",
        target: { courseId, lessonId: "10000000-0000-4000-8000-000000000099" },
      },
    })).success).toBe(false);
  });

  it("publishes additive v3 implementation state without changing learning precedence", async () => {
    const { MemberDashboardV3ResponseSchema } = await import("./member-dashboard.js");
    const value = {
      ...dashboardV2(),
      schemaVersion: 3,
      implementation: { state: "available", artifacts: implementationArtifacts },
    };
    expect(MemberDashboardV3ResponseSchema.parse(value)).toMatchObject({
      schemaVersion: 3,
      nextBestStep: dashboardV2().nextBestStep,
      implementation: {
        state: "available",
        artifacts: { implementationCompletion: { completed: false } },
      },
    });
    expect(MemberDashboardV3ResponseSchema.safeParse({
      ...value,
      nextBestStep: { kind: "course", reason: "required_lesson_locked", target: { courseId } },
    }).success).toBe(false);
    expect(MemberDashboardV3ResponseSchema.safeParse({
      ...value,
      experience: { state: "access_required" },
      implementation: { state: "available", artifacts: implementationArtifacts },
    }).success).toBe(false);
  });

  it("accepts exact v2 access, enrollment, locked, and completion states", async () => {
    const { MemberDashboardV2ResponseSchema } = await import("./member-dashboard.js");
    const course = dashboardV2().learning.course;
    const lockedCourse = {
      ...course,
      stages: course.stages.map((stage) => ({
        ...stage,
        lessons: stage.lessons.map((lesson) => ({ ...lesson, availability: "locked" })),
      })),
    };
    const values = [
      dashboardV2({
        access: access(false),
        experience: { state: "access_required" },
        learning: { state: "blocked", reason: "course_access_required" },
        nextBestStep: { kind: "access_blocker", reason: "academy_course_required", target: "program_options" },
      }),
      dashboardV2({
        experience: { state: "no_enrollment" },
        learning: { state: "empty", reason: "no_enrollment" },
        nextBestStep: { kind: "enrollment_blocker", reason: "academy_enrollment_missing", target: "retry" },
      }),
      dashboardV2({
        learning: { state: "available", course: lockedCourse },
        nextBestStep: { kind: "course", reason: "required_lesson_locked", target: { courseId } },
      }),
      dashboardV2({
        learning: {
          state: "available",
          course: {
            ...course,
            stages: course.stages.map((stage) => ({
              ...stage,
              lessons: stage.lessons.map((lesson) => ({ ...lesson, progress: "completed" })),
            })),
            progress: { completedRequired: 18, requiredTotal: 18, percent: 100 },
          },
        },
        nextBestStep: { kind: "course", reason: "required_lessons_completed", target: { courseId } },
      }),
    ];
    expect(values.every((value) => MemberDashboardV2ResponseSchema.safeParse(value).success)).toBe(true);
  });

  it.each([
    "2026-08-14T16:00:00Z",
    "2026-08-14T16:00:00.00Z",
    "2026-08-14T16:00:00.0000Z",
    "2026-08-14T12:00:00.000-04:00",
    "2026-02-30T16:00:00.000Z",
  ])("rejects noncanonical UTC millisecond instant %s", async (generatedAt) => {
    const { MemberDashboardResponseSchema } = await import("./member-dashboard.js");
    expect(MemberDashboardResponseSchema.safeParse(dashboard({ generatedAt })).success).toBe(false);
  });

  it("canonicalizes only ASCII edge spaces and preserves internal spaces", async () => {
    const { canonicalizeAccountName, isCanonicalAccountName } = await import("./member-dashboard.js");
    expect(canonicalizeAccountName("  Acme  Advisory  ")).toBe("Acme  Advisory");
    expect(isCanonicalAccountName("Acme  Advisory")).toBe(true);
    expect(isCanonicalAccountName(" Acme Advisory")).toBe(false);
    expect(isCanonicalAccountName("Cafe\u0301")).toBe(false);
  });

  it.each(["\t", "\n", "\r", "\u00a0", "\u061c", "\u200b", "\ufeff", "\ufdd0", "\ufffe", "\ud800"])(
    "rejects forbidden account-name scalar %j",
    async (scalar) => {
      const { canonicalizeAccountName, isCanonicalAccountName } = await import("./member-dashboard.js");
      expect(() => canonicalizeAccountName(`Acme${scalar}`)).toThrow("ACCOUNT_NAME_INVALID");
      expect(isCanonicalAccountName(`Acme${scalar}`)).toBe(false);
    },
  );

  it("enforces account-name UTF-8 byte boundaries", async () => {
    const { canonicalizeAccountName } = await import("./member-dashboard.js");
    expect(canonicalizeAccountName("a".repeat(255))).toHaveLength(255);
    expect(() => canonicalizeAccountName("a".repeat(256))).toThrow("ACCOUNT_NAME_INVALID");
    expect(canonicalizeAccountName("é".repeat(127) + "a")).toBe("é".repeat(127) + "a");
    expect(() => canonicalizeAccountName("é".repeat(128))).toThrow("ACCOUNT_NAME_INVALID");
  });

  it("rejects unknown fields and mismatched account scope", async () => {
    const { MemberDashboardResponseSchema } = await import("./member-dashboard.js");
    expect(MemberDashboardResponseSchema.safeParse({ ...dashboard(), role: "owner" }).success).toBe(false);
    expect(MemberDashboardResponseSchema.safeParse(dashboard({
      account: { id: "10000000-0000-4000-8000-000000000002", name: "Other" },
    })).success).toBe(false);
  });

  it.each([
    [dashboard({ experience: { state: "partial" } }), "Academy false cannot be partial"],
    [dashboard({ access: access(true) }), "Academy true cannot be access-required"],
    [dashboard({ access: access(true), experience: { state: "ready" }, projections: unavailable,
      nextBestStep: { kind: "none", reason: "no_action_available", target: null } }), "Unavailable cannot be ready"],
    [dashboard({ access: access(true), experience: { state: "partial" }, projections: unavailable,
      nextBestStep: { kind: "unavailable", blockedBy: "learning", reason: "module_not_implemented", target: "retry" } }), "Wrong unavailable precedence"],
    [dashboard({ access: access(true), experience: { state: "ready" }, projections: empty,
      nextBestStep: { kind: "none", reason: "no_action_available", target: "program_options" } }), "None target must be null"],
  ])("rejects invariant mismatch: %s", async (value) => {
    const { MemberDashboardResponseSchema } = await import("./member-dashboard.js");
    expect(MemberDashboardResponseSchema.safeParse(value).success).toBe(false);
  });

  it("accepts no-enrollment, partial, and all-known-empty ready states", async () => {
    const { MemberDashboardResponseSchema } = await import("./member-dashboard.js");
    const noEnrollmentProjections = {
      ...unavailable,
      learning: { state: "empty", reason: "no_enrollment" },
    } as const;
    const values = [
      dashboard({
        access: access(true),
        experience: { state: "no_enrollment" },
        projections: noEnrollmentProjections,
        nextBestStep: { kind: "enrollment_blocker", reason: "academy_enrollment_missing", target: "retry" },
      }),
      dashboard({
        access: access(true),
        experience: { state: "partial" },
        projections: unavailable,
        nextBestStep: { kind: "unavailable", blockedBy: "support", reason: "module_not_implemented", target: "retry" },
      }),
      dashboard({
        access: access(true),
        experience: { state: "ready" },
        projections: empty,
        nextBestStep: { kind: "none", reason: "no_action_available", target: null },
      }),
    ];
    expect(values.every((value) => MemberDashboardResponseSchema.safeParse(value).success)).toBe(true);
  });
});
