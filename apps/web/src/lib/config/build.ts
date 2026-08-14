export function parseWebBuildIdentity(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const releaseSha = environment.RELEASE_SHA?.trim();
  if (
    releaseSha === undefined
    || !/^[0-9a-f]{40}$/u.test(releaseSha)
    || (environment.GITHUB_SHA !== undefined
      && environment.GITHUB_SHA !== releaseSha)
    || ((environment.VERCEL === "1" || environment.VERCEL_ENV !== undefined)
      && (!/^[0-9a-f]{40}$/u.test(environment.VERCEL_GIT_COMMIT_SHA ?? "")
        || environment.VERCEL_GIT_COMMIT_SHA !== releaseSha))
  ) {
    throw new Error("WEB_RELEASE_IDENTITY_INVALID");
  }
  return releaseSha;
}

export function resolveWebDeploymentId(
  environment: Readonly<Record<string, string | undefined>>,
  releaseSha: string,
): string | undefined {
  return environment.NEXT_DEPLOYMENT_ID ? undefined : releaseSha;
}
