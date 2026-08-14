export type GateCheck = Readonly<{
  artifactHash?: string;
  command?: string;
  durationMs?: number;
  reason?: string;
  status: "PASS" | "FAILED" | "BLOCKED";
}>;

export type ProductionDependencyGraph = Readonly<{
  builtArtifacts: string[];
  environmentKeys: string[];
  imports: Array<{ path: string; specifier: string }>;
  lockfilePackages: string[];
  packages: string[];
  resolvedImports: Array<{
    path: string;
    resolvedPath: string;
    specifier: string;
  }>;
  urls: string[];
}>;

export const FOUNDATION_CHECK_CATALOG: readonly string[];
export const RELEASE_SHA_PATTERN: RegExp;
export function evaluateFoundationGate(
  checks: Readonly<Record<string, GateCheck>>,
): Readonly<{
  engineeringGate: "PASS" | "FAILED" | "BLOCKED";
  launchGate: "PASS" | "FAILED" | "BLOCKED";
}>;
export function evaluateProviderReleaseSha(
  environment: Readonly<Record<string, string | undefined>>,
  provider: "github" | "railway" | "vercel",
): GateCheck;
export function foundationExitCode(
  report: Readonly<{ engineeringGate: "PASS" | "FAILED" | "BLOCKED" }>,
): 0 | 1;
export function evaluateReleaseSha(releaseSha: string | undefined, headSha: string): GateCheck;
export function inspectRepositoryIdentity(
  repositoryRoot: string,
  expectedSha: string,
): Promise<Readonly<{
  headSha: string;
  reason?: string;
  status: "PASS" | "FAILED" | "BLOCKED";
}>>;
export function inspectProductionDependencyGraph(repositoryRoot: string): Promise<ProductionDependencyGraph>;
export function isForbiddenServerPackage(specifier: string): boolean;
export function runIndependentChecks(definitions: ReadonlyArray<Readonly<{
  command: string;
  name: string;
  run(signal: AbortSignal): Promise<void>;
  timeoutMs: number;
}>>): Promise<Record<string, GateCheck>>;
export function artifactHash(path: string): Promise<string>;
export function validateExternalEvidence(
  evidence: Readonly<Record<string, unknown>>,
  options: Readonly<{
    host?: string;
    now: Date;
    releaseSha: string;
    type: "images" | "proxy";
    upstreamOrigin?: string;
  }>,
): GateCheck;
export function validateFoundationReport<T>(report: T): T;
export function validateImageMetadata(metadata: Readonly<{
  command: string[];
  entrypoint: string[];
  files: string[];
  history: string[];
  labels: Record<string, string>;
  releaseSha: string;
  service: "api" | "cron" | "migrate" | "worker";
  user: string;
}>): GateCheck;
export function validateRailwayServiceConfigs(
  repositoryRoot: string,
  services?: readonly string[],
): Promise<Record<string, Readonly<{ command: string; dockerfilePath: string }>>>;
export function validateRequiredContracts(repositoryRoot: string): Promise<void>;
