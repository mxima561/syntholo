import { describe, expect, it } from "vitest";
import { LessonBlockSchema, ReleaseRuleSchema, TranscriptSchema } from "./blocks";

describe("content block contracts", () => {
  it("accepts the complete safe lesson block union and rejects unknown fields and unsafe URLs", () => {
    const blocks = [
      { type: "rich_text", blockId: "intro", document: { type: "doc", content: [] } },
      { type: "callout", blockId: "warning", tone: "warning", document: { type: "doc", content: [] } },
      { type: "checklist", blockId: "checks", title: "Before launch", items: ["Review"] },
      { type: "action", blockId: "action", title: "Do it", instructions: "Complete the work" },
      { type: "resource_list", blockId: "resources", resourceIds: ["10000000-0000-4000-8000-000000000001"] },
      { type: "recommendation", blockId: "recommendation", title: "Use this", rationale: "It is safer", externalHttpsUrl: "https://example.test/guide" },
      { type: "disclosure", blockId: "disclosure", disclosureKind: "commercial", policyVersion: "2026-08", document: { type: "doc", content: [] } },
      { type: "video", blockId: "video", mediaAssetId: "10000000-0000-4000-8000-000000000002" },
    ];

    expect(blocks.map((block) => LessonBlockSchema.parse(block).type)).toEqual([
      "rich_text", "callout", "checklist", "action", "resource_list",
      "recommendation", "disclosure", "video",
    ]);
    expect(() => LessonBlockSchema.parse({ ...blocks[0], html: "<script>" })).toThrow();
    expect(() => LessonBlockSchema.parse({ ...blocks[5], externalHttpsUrl: "javascript:alert(1)" })).toThrow();
    expect(() => LessonBlockSchema.parse({
      type: "rich_text", blockId: "unsafe-script",
      document: { type: "doc", content: [{ type: "script", src: "https://evil.test/x.js" }] },
    })).toThrow();
    expect(() => LessonBlockSchema.parse({
      type: "rich_text", blockId: "unsafe-style",
      document: { type: "doc", content: [{ type: "paragraph", style: "position:fixed", content: [] }] },
    })).toThrow();
    expect(() => LessonBlockSchema.parse({
      type: "rich_text", blockId: "unsafe-embed",
      document: { type: "doc", content: [{ type: "embed", html: "<iframe src='https://evil.test'>" }] },
    })).toThrow();
    expect(() => LessonBlockSchema.parse({
      type: "rich_text", blockId: "unsafe-link",
      document: { type: "doc", content: [{
        type: "paragraph", content: [{ type: "text", text: "click", marks: [{ type: "link", href: "javascript:alert(1)" }] }],
      }] },
    })).toThrow();
  });

  it("accepts only the three exact release rules", () => {
    expect(ReleaseRuleSchema.parse({ kind: "immediate" })).toEqual({ kind: "immediate" });
    expect(ReleaseRuleSchema.parse({ kind: "elapsed_days", days: 365 })).toEqual({ kind: "elapsed_days", days: 365 });
    expect(ReleaseRuleSchema.parse({ kind: "fixed_at", at: "2026-08-14T16:00:00.000Z" }).kind).toBe("fixed_at");
    expect(() => ReleaseRuleSchema.parse({ kind: "elapsed_days", days: 366 })).toThrow();
    expect(() => ReleaseRuleSchema.parse({ kind: "immediate", days: 1 })).toThrow();
    expect(() => ReleaseRuleSchema.parse({ kind: "elapsed_days", days: 1, at: "2026-08-14T16:00:00.000Z" })).toThrow();
    expect(() => ReleaseRuleSchema.parse({ kind: "fixed_at", at: "2026-08-14" })).toThrow();
    expect(() => ReleaseRuleSchema.parse({ kind: "fixed_at", at: "2026-08-14T16:00:00Z" })).toThrow();
    expect(() => ReleaseRuleSchema.parse({ kind: "fixed_at", at: "2026-08-14T12:00:00.000-04:00" })).toThrow();
    expect(() => ReleaseRuleSchema.parse({ kind: "fixed_at", at: "2026-02-30T16:00:00.000Z" })).toThrow();
    expect(() => ReleaseRuleSchema.parse({ kind: "weekly", week: 1 })).toThrow();
  });

  it("requires a complete bounded transcript with stable unique block IDs", () => {
    expect(TranscriptSchema.parse({ schemaVersion: 1, blocks: [
      { blockId: "t-1", text: "Complete transcript text." },
    ] }).blocks).toHaveLength(1);
    expect(() => TranscriptSchema.parse({ schemaVersion: 1, blocks: [
      { blockId: "same", text: "First" }, { blockId: "same", text: "Second" },
    ] })).toThrow();
    expect(() => TranscriptSchema.parse({ schemaVersion: 1, blocks: [
      { blockId: "blank", text: "   " },
    ] })).toThrow();
  });
});
