import { describe, expect, it } from "vitest";
import { canonicalContentManifest, contentManifestHash } from "./lifecycle.js";

describe("canonical content manifest", () => {
  const manifest = {
    schemaVersion: 1 as const,
    course: { id: "10000000-0000-4000-8000-000000000001", revision: 2, slug: "academy", title: "Academy", description: "Program" },
    stages: [{
      id: "10000000-0000-4000-8000-000000000002", slug: "diagnose", title: "Diagnose", order: 1,
      lessons: [{
        id: "10000000-0000-4000-8000-000000000003",
        lessonVersionId: "10000000-0000-4000-8000-000000000004",
        versionHash: "b".repeat(64), order: 1, required: true,
        releaseRule: { kind: "immediate" as const }, mediaAssetId: null,
        mediaReadinessRevision: null, captionTracks: [], resources: [],
      }],
    }],
  };

  it("sorts object keys recursively while preserving authoritative array order", () => {
    expect(canonicalContentManifest(manifest)).toBe(
      '{"course":{"description":"Program","id":"10000000-0000-4000-8000-000000000001","revision":2,"slug":"academy","title":"Academy"},"schemaVersion":1,"stages":[{"id":"10000000-0000-4000-8000-000000000002","lessons":[{"captionTracks":[],"id":"10000000-0000-4000-8000-000000000003","lessonVersionId":"10000000-0000-4000-8000-000000000004","mediaAssetId":null,"mediaReadinessRevision":null,"order":1,"releaseRule":{"kind":"immediate"},"required":true,"resources":[],"versionHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}],"order":1,"slug":"diagnose","title":"Diagnose"}]}'
    );
  });

  it("produces the same SHA-256 for object-key permutations but not changed array order", () => {
    const permuted = { stages: manifest.stages, course: { ...manifest.course }, schemaVersion: 1 as const };
    expect(contentManifestHash(permuted)).toBe(contentManifestHash(manifest));
    expect(contentManifestHash({ ...manifest, stages: [...manifest.stages].reverse() }))
      .toBe(contentManifestHash(manifest));
    const secondStage = { ...manifest.stages[0]!, id: "10000000-0000-4000-8000-000000000009", order: 2 };
    expect(contentManifestHash({ ...manifest, stages: [manifest.stages[0]!, secondStage] }))
      .not.toBe(contentManifestHash({ ...manifest, stages: [secondStage, manifest.stages[0]!] }));
  });
});
