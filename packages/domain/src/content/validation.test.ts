import { describe, expect, it } from "vitest";
import { publicationIssuesForLesson } from "./validation.js";

describe("lesson publication validation", () => {
  it("returns every blocker without accepting placeholder or whitespace content", () => {
    expect(publicationIssuesForLesson({
      lessonId: "10000000-0000-4000-8000-000000000001",
      title: "TODO", summary: " ", durationSeconds: 60, blocks: [],
      transcript: { schemaVersion: 1, blocks: [] }, mediaAssetId: null, mediaReady: false,
      signedPlaybackReady: false, captionsReady: false, readyResourceCount: 0,
      accessibilityApproved: false, disclosureDecided: false,
      placeholderDetected: true,
    }).map(({ code }) => code)).toEqual([
      "TITLE_REQUIRED", "SUMMARY_REQUIRED", "DURATION_OUT_OF_RANGE",
      "VIDEO_NOT_READY", "SIGNED_PLAYBACK_REQUIRED", "CAPTIONS_REQUIRED",
      "TRANSCRIPT_REQUIRED", "ACTION_REQUIRED", "RESOURCE_REQUIRED",
      "ACCESSIBILITY_REVIEW_REQUIRED", "DISCLOSURE_DECISION_REQUIRED",
      "PLACEHOLDER_CONTENT",
    ]);
  });

  it("returns no issues for one complete publishable lesson", () => {
    expect(publicationIssuesForLesson({
      lessonId: "10000000-0000-4000-8000-000000000001",
      title: "Map the customer journey", summary: "Identify one reliable improvement.",
      durationSeconds: 600,
      blocks: [
        { type: "video", blockId: "video", mediaAssetId: "10000000-0000-4000-8000-000000000002" },
        { type: "action", blockId: "action", title: "Map it", instructions: "Complete the map" },
      ],
      transcript: { schemaVersion: 1, blocks: [{ blockId: "t-1", text: "Full transcript." }] },
      mediaAssetId: "10000000-0000-4000-8000-000000000002",
      mediaReady: true, signedPlaybackReady: true, captionsReady: true,
      readyResourceCount: 1, accessibilityApproved: true,
      disclosureDecided: true, placeholderDetected: false,
    })).toEqual([]);
  });

  it("rejects action-only, duplicate-video, and mismatched media bindings", () => {
    const complete = {
      lessonId: "10000000-0000-4000-8000-000000000001",
      title: "Map the customer journey", summary: "Identify one reliable improvement.",
      durationSeconds: 600,
      transcript: { schemaVersion: 1 as const, blocks: [{ blockId: "t-1", text: "Full transcript." }] },
      mediaAssetId: "10000000-0000-4000-8000-000000000002",
      mediaReady: true, signedPlaybackReady: true, captionsReady: true,
      readyResourceCount: 1, accessibilityApproved: true,
      disclosureDecided: true, placeholderDetected: false,
    };
    const action = { type: "action", blockId: "action", title: "Map it", instructions: "Complete the map" };
    expect(publicationIssuesForLesson({ ...complete, blocks: [action] }).map(({ code }) => code))
      .toContain("VIDEO_NOT_READY");
    expect(publicationIssuesForLesson({ ...complete, blocks: [
      action,
      { type: "video", blockId: "video-1", mediaAssetId: complete.mediaAssetId },
      { type: "video", blockId: "video-2", mediaAssetId: complete.mediaAssetId },
    ] }).map(({ code }) => code)).toContain("VIDEO_NOT_READY");
    expect(publicationIssuesForLesson({ ...complete, blocks: [
      action,
      { type: "video", blockId: "video", mediaAssetId: "10000000-0000-4000-8000-000000000099" },
    ] }).map(({ code }) => code)).toContain("VIDEO_NOT_READY");
  });
});
