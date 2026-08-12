import { describe, expect, it } from "vitest";
import { getDashboard, getLesson, getMemberCourse } from "./repository";

describe("demo repository", () => {
  it("returns organization-scoped dashboard data for the signed-in owner", () => {
    const dashboard = getDashboard("member-maria");

    expect(dashboard.organization.name).toBe("Northstar Advisory");
    expect(dashboard.member.firstName).toBe("Maria");
    expect(dashboard.nextAction.kind).toBe("lesson");
  });

  it("keeps personal course progress separate from shared artifacts", () => {
    const course = getMemberCourse("member-maria");

    expect(course.completedLessonIds).toContain("diagnose-1");
    expect(course.artifacts.every((artifact) => artifact.organizationId === "org-northstar")).toBe(true);
  });

  it("returns undefined for an unknown lesson", () => {
    expect(getLesson("unknown")).toBeUndefined();
  });
});

