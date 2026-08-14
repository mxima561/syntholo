export function isDemoMode(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return environment.APP_MODE === "demo";
}
