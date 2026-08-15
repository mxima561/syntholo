import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  contentMediaAssets,
  contentMediaTracks,
  lessonDrafts,
  lessonVersions,
} from "./content.js";

describe("content media schema authority", () => {
  it("models one provider asset identity with signed playback and monotonic readiness", () => {
    expect(Object.keys(getTableColumns(contentMediaAssets))).toEqual([
      "id", "provider", "environmentId", "providerAssetId",
      "signedPolicyPlaybackId", "state", "durationMilliseconds", "aspectRatio",
      "safeErrorCode", "readinessRevision", "lastProviderEventAt",
      "lastProviderEventId", "lastReconciledAt", "importedAt",
      "importedByStaffId", "createdAt", "updatedAt",
    ]);
    const config = getTableConfig(contentMediaAssets);
    expect(config.uniqueConstraints.map(({ name }) => name))
      .toContain("content_media_assets_environment_asset_unique");
    expect(config.checks.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "content_media_assets_provider_check",
      "content_media_assets_state_check",
      "content_media_assets_signed_playback_check",
      "content_media_assets_revision_check",
    ]));
  });

  it("models only caption tracks with stable provider identity and revision", () => {
    expect(Object.keys(getTableColumns(contentMediaTracks))).toEqual([
      "id", "mediaAssetId", "providerTrackId", "kind", "language", "label",
      "closedCaptions", "source", "state", "safeErrorCode",
      "readinessRevision", "lastProviderEventAt", "lastProviderEventId",
      "createdAt", "updatedAt",
    ]);
    expect(getTableConfig(contentMediaTracks).foreignKeys.map((foreignKey) => foreignKey.getName()))
      .toContain("content_media_tracks_asset_fk");
  });

  it("uses the existing single mutable and immutable media bindings", () => {
    expect(getTableConfig(lessonDrafts).foreignKeys.map((foreignKey) => foreignKey.getName()))
      .toContain("lesson_drafts_media_asset_fk");
    expect(getTableConfig(lessonVersions).foreignKeys.map((foreignKey) => foreignKey.getName()))
      .toContain("lesson_versions_media_asset_fk");
  });
});
