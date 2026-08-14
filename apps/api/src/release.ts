declare const __SYNTHOLO_RELEASE_SHA__: string;

export const artifactReleaseSha = typeof __SYNTHOLO_RELEASE_SHA__ === "string"
  ? __SYNTHOLO_RELEASE_SHA__
  : undefined;
