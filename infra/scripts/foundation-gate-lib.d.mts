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
  urls: string[];
}>;

export const RELEASE_SHA_PATTERN: RegExp;
export function evaluateReleaseSha(releaseSha: string | undefined, headSha: string): GateCheck;
export function inspectProductionDependencyGraph(repositoryRoot: string): Promise<ProductionDependencyGraph>;
export function runIndependentChecks(definitions: ReadonlyArray<Readonly<{
  command: string;
  name: string;
  run(signal: AbortSignal): Promise<void>;
  timeoutMs: number;
}>>): Promise<Record<string, GateCheck>>;
export function artifactHash(path: string): Promise<string>;
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
