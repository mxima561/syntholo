const releaseShaPattern = /^[0-9a-f]{40}$/u;

export function createWebHealthResponse(
  environment: Readonly<Record<string, string | undefined>>,
  artifactReleaseSha: string | undefined,
) {
  const validArtifact = artifactReleaseSha !== undefined
    && releaseShaPattern.test(artifactReleaseSha);
  const matchesRuntime = validArtifact
    && environment.RELEASE_SHA === artifactReleaseSha;
  return {
    body: {
      releaseSha: validArtifact ? artifactReleaseSha : "unavailable",
      service: "web" as const,
      status: matchesRuntime ? "ok" as const : "degraded" as const,
    },
    status: matchesRuntime ? 200 : 503,
  };
}
