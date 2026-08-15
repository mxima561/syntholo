import { createHash } from "node:crypto";
import { get as vercelGet, put as vercelPut } from "@vercel/blob";

const objectKeyPattern = /^certificates\/v1\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const etagPattern = /^[\x21\x23-\x5b\x5d-\x7e]{1,255}$/u;
const maxCertificateBytes = 25 * 1_024 * 1_024;
const defaultOperationTimeoutMs = 15_000;

type PutOptions = Readonly<{
  access: "private";
  addRandomSuffix: false;
  allowOverwrite: false;
  contentType: "application/pdf";
  token: string;
  abortSignal: AbortSignal;
}>;

type GetOptions = Readonly<{
  access: "private";
  token: string;
  abortSignal: AbortSignal;
  useCache: false;
}>;

type Provider = Readonly<{
  put(pathname: string, bytes: Uint8Array, options: PutOptions): Promise<unknown>;
  get(pathname: string, options: GetOptions): Promise<unknown>;
}>;

type StoredCertificateObject = Readonly<{
  byteLength: number;
  sha256: string;
  etag: string;
  contentType: "application/pdf";
}>;

export class CertificateBlobError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "CertificateBlobError";
    this.retryable = retryable;
  }
}

function fail(code: string, retryable: boolean): never {
  throw new CertificateBlobError(code, retryable);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return value !== null && typeof value === "object"
    && typeof (value as { getReader?: unknown }).getReader === "function"
    && typeof (value as { cancel?: unknown }).cancel === "function";
}

function validPathname(value: string): boolean {
  return objectKeyPattern.test(value);
}

function parseTokenStoreId(token: string): string | null {
  const match = /^vercel_blob_rw_([A-Za-z0-9]{3,64})_[A-Za-z0-9_-]{24,512}$/u.exec(token);
  return match?.[1] ?? null;
}

function exactObjectUrl(value: unknown, expectedOrigin: string, pathname: string): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.origin === expectedOrigin
      && url.pathname === `/${pathname}`
      && url.search === ""
      && url.hash === ""
      && url.username === ""
      && url.password === "";
  } catch {
    return false;
  }
}

function normalizeEtag(value: unknown): string | null {
  if (typeof value !== "string" || value.startsWith("W/")) return null;
  const canonical = value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
  return etagPattern.test(canonical) ? canonical : null;
}

async function bestEffortCancel(cancel: () => Promise<unknown>): Promise<void> {
  try {
    await cancel();
  } catch {
    // Cancellation must never mask the primary integrity or dependency failure.
  }
}

function beginBestEffortCancel(cancel: () => Promise<unknown>): void {
  try {
    void cancel().catch(() => undefined);
  } catch {
    // Cancellation must never mask the primary integrity or dependency failure.
  }
}

async function boundedOperation<T>(
  parentSignal: AbortSignal,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  disposeLateResult?: (value: T) => Promise<void>,
  waitForAbortCleanup = false,
): Promise<T> {
  if (parentSignal.aborted) return fail("CERTIFICATE_BLOB_DEPENDENCY_UNAVAILABLE", true);
  const controller = new AbortController();
  const abort = () => controller.abort();
  parentSignal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  let pending: Promise<T> | undefined;
  let abandoned = false;
  try {
    if (controller.signal.aborted) return fail("CERTIFICATE_BLOB_DEPENDENCY_UNAVAILABLE", true);
    pending = operation(controller.signal);
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        if (waitForAbortCleanup) return;
        settled = true;
        abandoned = true;
        reject(new CertificateBlobError("CERTIFICATE_BLOB_DEPENDENCY_UNAVAILABLE", true));
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      pending!.then((value) => {
        if (settled) {
          if (abandoned && disposeLateResult !== undefined) {
            void disposeLateResult(value).catch(() => undefined);
          }
          return;
        }
        settled = true;
        controller.signal.removeEventListener("abort", onAbort);
        resolve(value);
      }, (error: unknown) => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener("abort", onAbort);
        reject(error);
      });
    });
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", abort);
    if (pending !== undefined) void pending.catch(() => undefined);
  }
}

async function cancelLateGetResult(result: unknown): Promise<void> {
  const value = record(result);
  const stream = value?.stream;
  if (readableStream(stream)) await bestEffortCancel(() => stream.cancel());
}

function inputAuthority(input: Readonly<{
  pathname: string;
  byteLength?: number;
  sha256: string;
  etag?: string;
  signal: AbortSignal;
}>): void {
  if (
    !validPathname(input.pathname)
    || !sha256Pattern.test(input.sha256)
    || !(input.signal instanceof AbortSignal)
    || (input.byteLength !== undefined
      && (!Number.isInteger(input.byteLength) || input.byteLength < 1 || input.byteLength > maxCertificateBytes))
    || (input.etag !== undefined && normalizeEtag(input.etag) !== input.etag)
  ) fail("CERTIFICATE_BLOB_INPUT_INVALID", false);
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  expectedLength: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) {
        await bestEffortCancel(() => reader.cancel());
        return fail("CERTIFICATE_BLOB_DEPENDENCY_UNAVAILABLE", true);
      }
      const result = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const aborted = () => {
          beginBestEffortCancel(() => reader.cancel());
          reject(new CertificateBlobError("CERTIFICATE_BLOB_DEPENDENCY_UNAVAILABLE", true));
        };
        signal.addEventListener("abort", aborted, { once: true });
        void reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
      });
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) return fail("CERTIFICATE_BLOB_PROVIDER_SHAPE_INVALID", false);
      total += result.value.byteLength;
      if (total > expectedLength || total > maxCertificateBytes) {
        await bestEffortCancel(() => reader.cancel());
        return fail("CERTIFICATE_BLOB_CONSISTENCY_INCIDENT", false);
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof CertificateBlobError) throw error;
    return fail("CERTIFICATE_BLOB_DEPENDENCY_UNAVAILABLE", true);
  } finally {
    reader.releaseLock();
  }
  if (total !== expectedLength) return fail("CERTIFICATE_BLOB_CONSISTENCY_INCIDENT", false);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export type PrivateCertificateBlobStore = Readonly<{
  upload(input: Readonly<{
    pathname: string;
    bytes: Uint8Array;
    sha256: string;
    signal: AbortSignal;
  }>): Promise<StoredCertificateObject>;
  download(input: Readonly<{
    pathname: string;
    expected: Readonly<{ byteLength: number; sha256: string; etag: string }>;
    signal: AbortSignal;
  }>): Promise<StoredCertificateObject & Readonly<{ bytes: Uint8Array }>>;
  reconcileUpload(input: Readonly<{
    pathname: string;
    expected: Readonly<{ byteLength: number; sha256: string }>;
    signal: AbortSignal;
  }>): Promise<StoredCertificateObject>;
}>;

export function createPrivateCertificateBlobStore(input: Readonly<{
  enabled: boolean;
  environment: "staging" | "production";
  token: string;
  storeIds: Readonly<{ staging: string; production: string }>;
  operationTimeoutMs?: number;
  provider?: Provider;
}>): PrivateCertificateBlobStore {
  if (!input.enabled) {
    return Object.freeze({
      async upload() { return fail("CERTIFICATE_BLOB_DISABLED", false); },
      async download() { return fail("CERTIFICATE_BLOB_DISABLED", false); },
      async reconcileUpload() { return fail("CERTIFICATE_BLOB_DISABLED", false); },
    });
  }
  const tokenStoreId = parseTokenStoreId(input.token);
  const operationTimeoutMs = input.operationTimeoutMs ?? defaultOperationTimeoutMs;
  const selectedStoreId = input.storeIds[input.environment];
  const expectedOrigin = `https://${selectedStoreId}.private.blob.vercel-storage.com`;
  if (
    tokenStoreId === null
    || tokenStoreId !== selectedStoreId
    || input.storeIds.staging === input.storeIds.production
    || !/^[A-Za-z0-9]{3,64}$/u.test(input.storeIds.staging)
    || !/^[A-Za-z0-9]{3,64}$/u.test(input.storeIds.production)
    || !Number.isInteger(operationTimeoutMs)
    || operationTimeoutMs < 100
    || operationTimeoutMs > 60_000
  ) return fail("CERTIFICATE_BLOB_CONFIG_INVALID", false);
  const provider: Provider = input.provider ?? {
    put: (pathname, bytes, options) => vercelPut(pathname, Buffer.from(bytes), options),
    get: (pathname, options) => vercelGet(pathname, options),
  };

  return Object.freeze({
    async upload(command) {
      inputAuthority({ pathname: command.pathname, sha256: command.sha256, signal: command.signal });
      if (!(command.bytes instanceof Uint8Array)
        || command.bytes.byteLength < 1
        || command.bytes.byteLength > maxCertificateBytes
        || createHash("sha256").update(command.bytes).digest("hex") !== command.sha256) {
        return fail("CERTIFICATE_BLOB_INPUT_INVALID", false);
      }
      if (command.signal.aborted) return fail("CERTIFICATE_BLOB_DEPENDENCY_UNAVAILABLE", true);
      let result: unknown;
      try {
        result = await boundedOperation(command.signal, operationTimeoutMs, (operationSignal) =>
          provider.put(command.pathname, command.bytes, {
            access: "private",
            addRandomSuffix: false,
            allowOverwrite: false,
            contentType: "application/pdf",
            token: input.token,
            abortSignal: operationSignal,
          }));
      } catch (error) {
        if (error instanceof CertificateBlobError) throw error;
        return fail("CERTIFICATE_BLOB_DEPENDENCY_UNAVAILABLE", true);
      }
      const value = record(result);
      if (
        value === null
        || value.pathname !== command.pathname
        || value.contentType !== "application/pdf"
        || normalizeEtag(value.etag) === null
        || !exactObjectUrl(value.url, expectedOrigin, command.pathname)
      ) return fail("CERTIFICATE_BLOB_PROVIDER_SHAPE_INVALID", false);
      return Object.freeze({
        byteLength: command.bytes.byteLength,
        sha256: command.sha256,
        etag: normalizeEtag(value.etag)!,
        contentType: "application/pdf" as const,
      });
    },

    async download(command) {
      inputAuthority({
        pathname: command.pathname,
        byteLength: command.expected.byteLength,
        sha256: command.expected.sha256,
        etag: command.expected.etag,
        signal: command.signal,
      });
      if (command.signal.aborted) return fail("CERTIFICATE_BLOB_DEPENDENCY_UNAVAILABLE", true);
      let result: unknown;
      try {
        result = await boundedOperation(command.signal, operationTimeoutMs, (operationSignal) =>
          provider.get(command.pathname, {
            access: "private",
            token: input.token,
            abortSignal: operationSignal,
            useCache: false,
          }), cancelLateGetResult);
      } catch (error) {
        if (error instanceof CertificateBlobError) throw error;
        return fail("CERTIFICATE_BLOB_DEPENDENCY_UNAVAILABLE", true);
      }
      if (result === null) return fail("CERTIFICATE_BLOB_NOT_FOUND", false);
      const value = record(result);
      const metadata = record(value?.blob);
      const headers = record(value?.headers);
      const stream = value?.stream;
      const acquiredStream = readableStream(stream) ? stream : null;
      if (
        value?.statusCode !== 200
        || metadata === null
        || metadata.pathname !== command.pathname
        || metadata.contentType !== "application/pdf"
        || metadata.size !== command.expected.byteLength
        || normalizeEtag(metadata.etag) !== command.expected.etag
        || !exactObjectUrl(metadata.url, expectedOrigin, command.pathname)
        || headers === null
        || typeof headers.get !== "function"
        || String(headers.get.call(value?.headers, "content-type")).split(";", 1)[0]?.trim().toLowerCase() !== "application/pdf"
        || Number(headers.get.call(value?.headers, "content-length")) !== command.expected.byteLength
        || normalizeEtag(headers.get.call(value?.headers, "etag")) !== command.expected.etag
        || acquiredStream === null
      ) {
        if (acquiredStream !== null) await bestEffortCancel(() => acquiredStream.cancel());
        return fail("CERTIFICATE_BLOB_CONSISTENCY_INCIDENT", false);
      }
      const bytes = await boundedOperation(command.signal, operationTimeoutMs, (operationSignal) =>
        readBounded(acquiredStream, command.expected.byteLength, operationSignal), undefined, true);
      const actualHash = createHash("sha256").update(bytes).digest("hex");
      if (actualHash !== command.expected.sha256) return fail("CERTIFICATE_BLOB_CONSISTENCY_INCIDENT", false);
      return Object.freeze({
        bytes,
        byteLength: bytes.byteLength,
        sha256: actualHash,
        etag: command.expected.etag,
        contentType: "application/pdf" as const,
      });
    },

    async reconcileUpload(command) {
      inputAuthority({
        pathname: command.pathname,
        byteLength: command.expected.byteLength,
        sha256: command.expected.sha256,
        signal: command.signal,
      });
      if (command.signal.aborted) return fail("CERTIFICATE_BLOB_DEPENDENCY_UNAVAILABLE", true);
      let result: unknown;
      try {
        result = await boundedOperation(command.signal, operationTimeoutMs, (operationSignal) =>
          provider.get(command.pathname, {
            access: "private",
            token: input.token,
            abortSignal: operationSignal,
            useCache: false,
          }), cancelLateGetResult);
      } catch (error) {
        if (error instanceof CertificateBlobError) throw error;
        return fail("CERTIFICATE_BLOB_DEPENDENCY_UNAVAILABLE", true);
      }
      if (result === null) return fail("CERTIFICATE_BLOB_NOT_FOUND", false);
      const value = record(result);
      const metadata = record(value?.blob);
      const headers = record(value?.headers);
      const stream = value?.stream;
      const acquiredStream = readableStream(stream) ? stream : null;
      const metadataEtag = normalizeEtag(metadata?.etag);
      const headerEtag = headers !== null && typeof headers.get === "function"
        ? normalizeEtag(headers.get.call(value?.headers, "etag"))
        : null;
      if (
        value?.statusCode !== 200
        || metadata === null
        || metadata.pathname !== command.pathname
        || metadata.contentType !== "application/pdf"
        || metadata.size !== command.expected.byteLength
        || metadataEtag === null
        || headerEtag !== metadataEtag
        || !exactObjectUrl(metadata.url, expectedOrigin, command.pathname)
        || headers === null
        || typeof headers.get !== "function"
        || String(headers.get.call(value?.headers, "content-type")).split(";", 1)[0]?.trim().toLowerCase() !== "application/pdf"
        || Number(headers.get.call(value?.headers, "content-length")) !== command.expected.byteLength
        || acquiredStream === null
      ) {
        if (acquiredStream !== null) await bestEffortCancel(() => acquiredStream.cancel());
        return fail("CERTIFICATE_BLOB_CONSISTENCY_INCIDENT", false);
      }
      const objectBytes = await boundedOperation(command.signal, operationTimeoutMs, (operationSignal) =>
        readBounded(acquiredStream, command.expected.byteLength, operationSignal), undefined, true);
      const actualHash = createHash("sha256").update(objectBytes).digest("hex");
      if (actualHash !== command.expected.sha256) {
        return fail("CERTIFICATE_BLOB_CONSISTENCY_INCIDENT", false);
      }
      return Object.freeze({
        byteLength: objectBytes.byteLength,
        sha256: actualHash,
        etag: metadataEtag,
        contentType: "application/pdf" as const,
      });
    },
  });
}
