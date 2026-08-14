export function parseWebBuildIdentity(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const releaseSha = environment.RELEASE_SHA?.trim();
  if (
    releaseSha === undefined
    || !/^[0-9a-f]{40}$/u.test(releaseSha)
    || (environment.GITHUB_SHA !== undefined
      && environment.GITHUB_SHA !== releaseSha)
  ) {
    throw new Error("WEB_RELEASE_IDENTITY_INVALID");
  }
  return releaseSha;
}
