import { createHash } from "node:crypto";
import { Headers as UndiciHeaders } from "undici";
import { describe, expect, it, vi } from "vitest";

async function loadPrivateCertificates() {
  return import("./private-certificates.js").catch(() => null);
}

const accountId = "10000000-0000-4000-8000-000000000001";
const courseCompletionId = "10000000-0000-4000-8000-000000000002";
const pathname = `certificates/v1/${accountId}/${courseCompletionId}.pdf`;
const bytes = new TextEncoder().encode("%PDF-1.7\nprivate-certificate-fixture");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const token = "vercel_blob_rw_stagingcertificates_abcdefghijklmnopqrstuvwxyz012345";

describe("private certificate Blob boundary", () => {
  it("uploads once with the exact private deterministic operation", async () => {
    const blob = await loadPrivateCertificates();
    expect(blob, "private certificate Blob boundary must exist").not.toBeNull();
    if (blob === null) return;

    const put = vi.fn(async () => ({
      url: `https://stagingcertificates.private.blob.vercel-storage.com/${pathname}`,
      downloadUrl: `https://stagingcertificates.private.blob.vercel-storage.com/${pathname}?download=1`,
      pathname,
      contentType: "application/pdf",
      contentDisposition: "attachment",
      etag: '"etag-staging-1"',
    }));
    const store = blob.createPrivateCertificateBlobStore({
      enabled: true,
      environment: "staging",
      token,
      storeIds: { staging: "stagingcertificates", production: "productioncertificates" },
      provider: { put, get: vi.fn() },
    });
    const signal = new AbortController().signal;
    await expect(store.upload({ pathname, bytes, sha256, signal })).resolves.toEqual({
      byteLength: bytes.byteLength,
      sha256,
      etag: "etag-staging-1",
      contentType: "application/pdf",
    });
    expect(put).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledWith(pathname, bytes, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: "application/pdf",
      token,
      abortSignal: expect.any(AbortSignal),
    });
    const putCall = put.mock.calls[0] as unknown as [string, Uint8Array, { abortSignal: AbortSignal }];
    expect(putCall[2].abortSignal).not.toBe(signal);
  });

  it("server-fetches and reconciles the exact private object without returning its URL", async () => {
    const blob = await loadPrivateCertificates();
    expect(blob).not.toBeNull();
    if (blob === null) return;

    const get = vi.fn(async () => ({
      statusCode: 200,
      stream: new Blob([bytes], { type: "application/pdf" }).stream(),
      headers: new UndiciHeaders({ "content-length": String(bytes.byteLength), "content-type": "application/pdf", etag: '"etag-staging-1"' }),
      blob: {
        url: `https://stagingcertificates.private.blob.vercel-storage.com/${pathname}`,
        downloadUrl: `https://stagingcertificates.private.blob.vercel-storage.com/${pathname}?download=1`,
        pathname,
        contentType: "application/pdf",
        contentDisposition: "attachment",
        size: bytes.byteLength,
        uploadedAt: new Date("2026-08-15T12:05:00.000Z"),
        etag: '"etag-staging-1"',
      },
    }));
    const store = blob.createPrivateCertificateBlobStore({
      enabled: true,
      environment: "staging",
      token,
      storeIds: { staging: "stagingcertificates", production: "productioncertificates" },
      provider: { put: vi.fn(), get },
    });
    const signal = new AbortController().signal;
    const downloaded = await store.download({
      pathname,
      expected: { byteLength: bytes.byteLength, sha256, etag: "etag-staging-1" },
      signal,
    });
    expect(downloaded).toEqual({
      bytes,
      byteLength: bytes.byteLength,
      sha256,
      etag: "etag-staging-1",
      contentType: "application/pdf",
    });
    expect(JSON.stringify(downloaded)).not.toContain("blob.vercel-storage.com");
    expect(JSON.stringify(downloaded)).not.toContain(token);
    expect(get).toHaveBeenCalledWith(pathname, {
      access: "private",
      token,
      abortSignal: expect.any(AbortSignal),
      useCache: false,
    });
    const getCall = get.mock.calls[0] as unknown as [string, { abortSignal: AbortSignal }];
    expect(getCall[1].abortSignal).not.toBe(signal);
  });

  it("recovers a lost PUT response by reading the deterministic object and deriving its strong ETag", async () => {
    const blob = await loadPrivateCertificates();
    expect(blob).not.toBeNull();
    if (blob === null) return;

    const get = vi.fn(async () => ({
      statusCode: 200,
      stream: new Blob([bytes], { type: "application/pdf" }).stream(),
      headers: new UndiciHeaders({
        "content-length": String(bytes.byteLength),
        "content-type": "application/pdf",
        etag: '"etag-staging-orphan"',
      }),
      blob: {
        url: `https://stagingcertificates.private.blob.vercel-storage.com/${pathname}`,
        pathname,
        contentType: "application/pdf",
        size: bytes.byteLength,
        etag: '"etag-staging-orphan"',
      },
    }));
    const store = blob.createPrivateCertificateBlobStore({
      enabled: true,
      environment: "staging",
      token,
      storeIds: { staging: "stagingcertificates", production: "productioncertificates" },
      provider: { put: vi.fn(), get },
    });
    await expect(store.reconcileUpload({
      pathname,
      expected: { byteLength: bytes.byteLength, sha256 },
      signal: new AbortController().signal,
    })).resolves.toEqual({
      byteLength: bytes.byteLength,
      sha256,
      etag: "etag-staging-orphan",
      contentType: "application/pdf",
    });
  });

  it("fails closed on disabled, cross-environment, provider-shape, and object mismatch", async () => {
    const blob = await loadPrivateCertificates();
    expect(blob).not.toBeNull();
    if (blob === null) return;

    expect(() => blob.createPrivateCertificateBlobStore({
      enabled: true,
      environment: "production",
      token,
      storeIds: { staging: "stagingcertificates", production: "productioncertificates" },
      provider: { put: vi.fn(), get: vi.fn() },
    })).toThrow("CERTIFICATE_BLOB_CONFIG_INVALID");
    expect(() => blob.createPrivateCertificateBlobStore({
      enabled: false,
      environment: "staging",
      token: "",
      storeIds: { staging: "", production: "" },
      provider: { put: vi.fn(), get: vi.fn() },
    })).not.toThrow();

    const mismatched = blob.createPrivateCertificateBlobStore({
      enabled: true,
      environment: "staging",
      token,
      storeIds: { staging: "stagingcertificates", production: "productioncertificates" },
      provider: {
        put: vi.fn(),
        get: vi.fn(async () => ({
          statusCode: 200,
          stream: new Blob([new TextEncoder().encode("different")]).stream(),
          headers: new Headers({ "content-length": "9", "content-type": "application/pdf", etag: "wrong-etag" }),
          blob: {
            url: `https://stagingcertificates.private.blob.vercel-storage.com/${pathname}`,
            pathname,
            contentType: "application/pdf",
            size: 9,
            etag: "wrong-etag",
          },
        })),
      },
    });
    await expect(mismatched.download({
      pathname,
      expected: { byteLength: bytes.byteLength, sha256, etag: "etag-staging-1" },
      signal: new AbortController().signal,
    })).rejects.toThrow("CERTIFICATE_BLOB_CONSISTENCY_INCIDENT");
  });

  it("rejects caller hash drift and each upload provider-authority drift independently", async () => {
    const blob = await loadPrivateCertificates();
    expect(blob).not.toBeNull();
    if (blob === null) return;

    const put = vi.fn();
    const get = vi.fn();
    const store = blob.createPrivateCertificateBlobStore({
      enabled: true,
      environment: "staging",
      token,
      storeIds: { staging: "stagingcertificates", production: "productioncertificates" },
      provider: { put, get },
    });
    await expect(store.upload({
      pathname,
      bytes,
      sha256: "0".repeat(64),
      signal: new AbortController().signal,
    })).rejects.toThrow("CERTIFICATE_BLOB_INPUT_INVALID");
    expect(put).not.toHaveBeenCalled();
    const valid = {
      url: `https://stagingcertificates.private.blob.vercel-storage.com/${pathname}`,
      downloadUrl: `https://stagingcertificates.private.blob.vercel-storage.com/${pathname}?download=1`,
      pathname,
      contentType: "application/pdf",
      contentDisposition: "attachment",
      etag: "etag-staging-1",
    };
    for (const drift of [
      { url: `https://wrong.private.blob.vercel-storage.com/${pathname}` },
      { url: `${valid.url}?secret=query` },
      { pathname: `${pathname}.wrong` },
      { contentType: "text/plain" },
      { etag: "" },
      { etag: 'W/"weak"' },
    ]) {
      put.mockResolvedValueOnce({ ...valid, ...drift });
      await expect(store.upload({
        pathname,
        bytes,
        sha256,
        signal: new AbortController().signal,
      })).rejects.toThrow("CERTIFICATE_BLOB_PROVIDER_SHAPE_INVALID");
    }
  });

  it("cancels truncated, oversized, and mid-transfer-aborted downloads promptly", async () => {
    const blob = await loadPrivateCertificates();
    expect(blob).not.toBeNull();
    if (blob === null) return;

    const get = vi.fn();
    const store = blob.createPrivateCertificateBlobStore({
      enabled: true,
      environment: "staging",
      token,
      storeIds: { staging: "stagingcertificates", production: "productioncertificates" },
      provider: { put: vi.fn(), get },
    });
    const metadata = {
      url: `https://stagingcertificates.private.blob.vercel-storage.com/${pathname}`,
      downloadUrl: `https://stagingcertificates.private.blob.vercel-storage.com/${pathname}?download=1`,
      pathname,
      contentType: "application/pdf",
      contentDisposition: "attachment",
      cacheControl: "private, no-store",
      size: bytes.byteLength,
      uploadedAt: new Date("2026-08-15T12:05:00.000Z"),
      etag: "etag-staging-1",
    };
    const headers = new UndiciHeaders({
      "content-length": String(bytes.byteLength),
      "content-type": "application/pdf",
      etag: "etag-staging-1",
    });

    for (const body of [bytes.subarray(0, bytes.byteLength - 1)]) {
      get.mockResolvedValueOnce({
        statusCode: 200,
        stream: new Blob([body]).stream(),
        headers,
        blob: metadata,
      });
      await expect(store.download({
        pathname,
        expected: { byteLength: bytes.byteLength, sha256, etag: "etag-staging-1" },
        signal: new AbortController().signal,
      })).rejects.toThrow("CERTIFICATE_BLOB_CONSISTENCY_INCIDENT");
    }

    const oversizedCancel = vi.fn();
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(bytes.byteLength + 1)); },
      cancel: oversizedCancel,
    });
    get.mockResolvedValueOnce({ statusCode: 200, stream: oversized, headers, blob: metadata });
    await expect(store.download({
      pathname,
      expected: { byteLength: bytes.byteLength, sha256, etag: "etag-staging-1" },
      signal: new AbortController().signal,
    })).rejects.toThrow("CERTIFICATE_BLOB_CONSISTENCY_INCIDENT");
    expect(oversizedCancel).toHaveBeenCalledOnce();

    const midstreamCancel = vi.fn(async () => undefined);
    const midstreamRead = vi.fn(() => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined));
    const midstream = {
      cancel: vi.fn(async () => undefined),
      getReader: () => ({
        read: midstreamRead,
        cancel: midstreamCancel,
        releaseLock: vi.fn(),
      }),
    } as unknown as ReadableStream<Uint8Array>;
    get.mockResolvedValueOnce({ statusCode: 200, stream: midstream, headers, blob: metadata });
    const abortController = new AbortController();
    const pending = store.download({
      pathname,
      expected: { byteLength: bytes.byteLength, sha256, etag: "etag-staging-1" },
      signal: abortController.signal,
    });
    await vi.waitFor(() => expect(midstreamRead).toHaveBeenCalledOnce());
    const pendingOutcome = expect(pending).rejects.toThrow("CERTIFICATE_BLOB_DEPENDENCY_UNAVAILABLE");
    abortController.abort();
    await pendingOutcome;
    expect(midstreamCancel).toHaveBeenCalledOnce();

    const aborted = new AbortController();
    aborted.abort();
    await expect(store.download({
      pathname,
      expected: { byteLength: bytes.byteLength, sha256, etag: "etag-staging-1" },
      signal: aborted.signal,
    })).rejects.toThrow("CERTIFICATE_BLOB_DEPENDENCY_UNAVAILABLE");
  });

  it("rejects each download metadata drift independently and cancels acquired streams", async () => {
    const blob = await loadPrivateCertificates();
    expect(blob).not.toBeNull();
    if (blob === null) return;
    const get = vi.fn();
    const store = blob.createPrivateCertificateBlobStore({
      enabled: true,
      environment: "staging",
      token,
      storeIds: { staging: "stagingcertificates", production: "productioncertificates" },
      provider: { put: vi.fn(), get },
    });
    const validBlob = {
      url: `https://stagingcertificates.private.blob.vercel-storage.com/${pathname}`,
      downloadUrl: `https://stagingcertificates.private.blob.vercel-storage.com/${pathname}?download=1`,
      pathname,
      contentType: "application/pdf",
      contentDisposition: "attachment",
      cacheControl: "private, no-store",
      size: bytes.byteLength,
      uploadedAt: new Date("2026-08-15T12:05:00.000Z"),
      etag: "etag-staging-1",
    };
    const validHeaders = {
      "content-length": String(bytes.byteLength),
      "content-type": "application/pdf",
      etag: "etag-staging-1",
    };
    const cases = [
      { statusCode: 304 },
      { blob: { ...validBlob, url: `https://wrong.private.blob.vercel-storage.com/${pathname}` } },
      { blob: { ...validBlob, url: "not-a-provider-url" } },
      { blob: { ...validBlob, url: `${validBlob.url}?secret=query` } },
      { blob: { ...validBlob, pathname: `${pathname}.wrong` } },
      { blob: { ...validBlob, contentType: "text/plain" } },
      { blob: { ...validBlob, size: bytes.byteLength + 1 } },
      { blob: { ...validBlob, etag: "" } },
      { blob: { ...validBlob, etag: 'W/"weak"' } },
      { headers: new UndiciHeaders({ ...validHeaders, "content-type": "text/plain" }) },
      { headers: new UndiciHeaders({ ...validHeaders, "content-length": String(bytes.byteLength + 1) }) },
      { headers: new UndiciHeaders({ ...validHeaders, etag: "wrong-etag" }) },
      { stream: "not-a-stream" },
    ];
    for (const drift of cases) {
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(bytes); },
        cancel,
      });
      get.mockResolvedValueOnce({
        statusCode: 200,
        stream,
        headers: new UndiciHeaders(validHeaders),
        blob: validBlob,
        ...drift,
      });
      await expect(store.download({
        pathname,
        expected: { byteLength: bytes.byteLength, sha256, etag: "etag-staging-1" },
        signal: new AbortController().signal,
      })).rejects.toThrow("CERTIFICATE_BLOB_CONSISTENCY_INCIDENT");
      if (drift.stream === undefined) expect(cancel).toHaveBeenCalledOnce();
    }

    const rejectingCancel = vi.fn(async () => {
      throw new Error("provider cancel failed");
    });
    get.mockResolvedValueOnce({
      statusCode: 304,
      stream: new ReadableStream<Uint8Array>({ cancel: rejectingCancel }),
      headers: new UndiciHeaders(validHeaders),
      blob: validBlob,
    });
    await expect(store.download({
      pathname,
      expected: { byteLength: bytes.byteLength, sha256, etag: "etag-staging-1" },
      signal: new AbortController().signal,
    })).rejects.toThrow("CERTIFICATE_BLOB_CONSISTENCY_INCIDENT");
    expect(rejectingCancel).toHaveBeenCalledOnce();
  });

  it("bounds put, get, and stream work and disposes late provider streams", async () => {
    vi.useFakeTimers();
    try {
      const blob = await loadPrivateCertificates();
      expect(blob).not.toBeNull();
      if (blob === null) return;
      const configuration = {
        enabled: true as const,
        environment: "staging" as const,
        token,
        storeIds: { staging: "stagingcertificates", production: "productioncertificates" },
        operationTimeoutMs: 100,
      };

      let putSignal: AbortSignal | undefined;
      const hungPut = vi.fn((_path: string, _body: Uint8Array, options: { abortSignal: AbortSignal }) => {
        putSignal = options.abortSignal;
        return new Promise<never>(() => undefined);
      });
      const putStore = blob.createPrivateCertificateBlobStore({
        ...configuration,
        provider: { put: hungPut, get: vi.fn() },
      });
      const putOutcome = putStore.upload({ pathname, bytes, sha256, signal: new AbortController().signal });
      const putAssertion = expect(putOutcome).rejects.toThrow("CERTIFICATE_BLOB_DEPENDENCY_UNAVAILABLE");
      await vi.advanceTimersByTimeAsync(100);
      await putAssertion;
      expect(putSignal?.aborted).toBe(true);

      let resolveGet!: (value: unknown) => void;
      const lateCancel = vi.fn();
      const lateStream = new ReadableStream<Uint8Array>({ cancel: lateCancel });
      const hungGet = vi.fn(() => new Promise<unknown>((resolve) => { resolveGet = resolve; }));
      const getStore = blob.createPrivateCertificateBlobStore({
        ...configuration,
        provider: { put: vi.fn(), get: hungGet },
      });
      const getOutcome = getStore.download({
        pathname,
        expected: { byteLength: bytes.byteLength, sha256, etag: "etag-staging-1" },
        signal: new AbortController().signal,
      });
      const getAssertion = expect(getOutcome).rejects.toThrow("CERTIFICATE_BLOB_DEPENDENCY_UNAVAILABLE");
      await vi.advanceTimersByTimeAsync(100);
      await getAssertion;
      resolveGet({ stream: lateStream });
      await vi.waitFor(() => expect(lateCancel).toHaveBeenCalledOnce());

      const streamCancel = vi.fn(async () => undefined);
      const hungStream = {
        cancel: vi.fn(async () => undefined),
        getReader: () => ({
          read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
          cancel: streamCancel,
          releaseLock: vi.fn(),
        }),
      } as unknown as ReadableStream<Uint8Array>;
      const headers = new UndiciHeaders({
        "content-length": String(bytes.byteLength),
        "content-type": "application/pdf",
        etag: "etag-staging-1",
      });
      const streamStore = blob.createPrivateCertificateBlobStore({
        ...configuration,
        provider: {
          put: vi.fn(),
          get: vi.fn(async () => ({
            statusCode: 200,
            stream: hungStream,
            headers,
            blob: {
              url: `https://stagingcertificates.private.blob.vercel-storage.com/${pathname}`,
              pathname,
              contentType: "application/pdf",
              size: bytes.byteLength,
              etag: "etag-staging-1",
            },
          })),
        },
      });
      const streamOutcome = streamStore.download({
        pathname,
        expected: { byteLength: bytes.byteLength, sha256, etag: "etag-staging-1" },
        signal: new AbortController().signal,
      });
      const streamAssertion = expect(streamOutcome).rejects.toThrow("CERTIFICATE_BLOB_DEPENDENCY_UNAVAILABLE");
      await vi.advanceTimersByTimeAsync(100);
      await streamAssertion;
      expect(streamCancel).toHaveBeenCalledOnce();

      const preAborted = new AbortController();
      preAborted.abort();
      const notCalled = vi.fn();
      const preAbortedStore = blob.createPrivateCertificateBlobStore({
        ...configuration,
        provider: { put: notCalled, get: vi.fn() },
      });
      await expect(preAbortedStore.upload({ pathname, bytes, sha256, signal: preAborted.signal }))
        .rejects.toMatchObject({ message: "CERTIFICATE_BLOB_DEPENDENCY_UNAVAILABLE", retryable: true });
      expect(notCalled).not.toHaveBeenCalled();

      const synchronous = blob.createPrivateCertificateBlobStore({
        ...configuration,
        provider: {
          put: vi.fn(() => { throw new Error("synchronous provider failure"); }),
          get: vi.fn(),
        },
      });
      await expect(synchronous.upload({ pathname, bytes, sha256, signal: new AbortController().signal }))
        .rejects.toThrow("CERTIFICATE_BLOB_DEPENDENCY_UNAVAILABLE");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
