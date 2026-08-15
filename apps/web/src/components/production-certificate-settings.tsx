"use client";

import { useAuth } from "@clerk/react";
import {
  CertificateListResponseSchema,
  CertificateRecipientNameResponseSchema,
  canonicalizeCertificateRecipientNameInput,
  type CertificateListItem,
  type CertificateRecipientNameResponse,
} from "@syntholo/contracts/learning";
import { ApiErrorSchema } from "@syntholo/contracts/http";
import { Download, FileCheck2, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createMemberApiClient } from "@/lib/api/client";

type Ready = Readonly<{ state: "ready"; name: CertificateRecipientNameResponse; items: readonly CertificateListItem[]; nextCursor: string | null }>;
type Workspace = Ready
  | Readonly<{ state: "loading" }>
  | Readonly<{ state: "unauthorized" }>
  | Readonly<{ state: "unavailable" }>;
type NameStatus = "idle" | "saving" | "saved" | "invalid" | "ambiguous" | "conflict";
type NameIntent = Readonly<{ key: string; body: string }>;

function validJson(response: Response): boolean {
  return /^application\/json(?:;|$)/iu.test(response.headers.get("content-type") ?? "");
}

async function errorCode(response: Response): Promise<string | null> {
  if (!validJson(response)) return null;
  try {
    const parsed = ApiErrorSchema.safeParse(await response.clone().json());
    return parsed.success && response.headers.get("x-correlation-id") === parsed.data.error.correlationId ? parsed.data.error.code : null;
  } catch { return null; }
}

function statusLabel(item: CertificateListItem): string {
  switch (item.status) {
    case "awaiting_recipient_name": return "Name required";
    case "pending": return "Preparing";
    case "failed": return "Needs attention";
    case "issued": return "Ready to download";
  }
}

function failureCopy(item: CertificateListItem): string | null {
  if (item.status !== "failed") return null;
  switch (item.failureCode) {
    case "snapshot_not_renderable": return "This completion cannot be rendered with the available certificate typography.";
    case "render_failed": return "The certificate could not be rendered. Our team can review it.";
    case "storage_failed": return "Private file storage did not complete. Our team can retry it safely.";
  }
}

function completedDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value));
}

function intentKey(): string { return `certificate-name-${globalThis.crypto.randomUUID()}`; }

function CertificateCard({ item, download, downloadState }: Readonly<{
  item: CertificateListItem;
  download(item: CertificateListItem): void;
  downloadState: "idle" | "downloading" | "failed";
}>) {
  const failure = failureCopy(item);
  return (
    <article className="production-certificate-card">
      <header><span className={`production-certificate-status is-${item.status}`}>{statusLabel(item)}</span><span>Completed {completedDate(item.completedAt)}</span></header>
      <h3>{item.snapshotRenderable ? item.courseTitle : "Course title unavailable"}</h3>
      <p>{item.snapshotRenderable ? item.businessName : "Business name unavailable"}</p>
      <dl><div><dt>Recipient</dt><dd>{item.recipientName ?? "Confirm a recipient name"}</dd></div><div><dt>Course version</dt><dd>{item.courseVersion}</dd></div></dl>
      {item.status === "awaiting_recipient_name" ? <p className="production-certificate-note">Confirm your recipient name above to continue.</p> : null}
      {item.status === "pending" ? <p className="production-certificate-note">Your private PDF is being prepared.</p> : null}
      {failure ? <p className="production-certificate-note is-error">{failure}</p> : null}
      {item.status === "issued" ? <button className="button button-dark button-medium" disabled={downloadState === "downloading"} onClick={() => download(item)} type="button"><Download aria-hidden="true" size={17} />{downloadState === "downloading" ? "Preparing private download" : "Download private PDF"}</button> : null}
      {downloadState === "failed" ? <p className="production-certificate-note is-error" role="alert">Private download is unavailable. Try again.</p> : null}
    </article>
  );
}

function CertificateWorkspace({ getToken }: Readonly<{ getToken(): Promise<string | null> }>) {
  const [workspace, setWorkspace] = useState<Workspace>({ state: "loading" });
  const [draft, setDraft] = useState("");
  const [nameStatus, setNameStatus] = useState<NameStatus>("idle");
  const [comparison, setComparison] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [pendingIntent, setPendingIntent] = useState<NameIntent | null>(null);
  const [downloadStates, setDownloadStates] = useState<Record<string, "idle" | "downloading" | "failed">>({});
  const alive = useRef(true);
  const listGeneration = useRef(0);
  const downloadControllers = useRef(new Set<AbortController>());
  const api = useMemo(() => createMemberApiClient({ getToken }), [getToken]);

  async function parseName(response: Response): Promise<CertificateRecipientNameResponse> {
    if (!response.ok || !validJson(response)) throw new Error("CERTIFICATE_NAME_RESPONSE_INVALID");
    return CertificateRecipientNameResponseSchema.parse(await response.json());
  }

  const refreshCertificates = useCallback(async (): Promise<void> => {
    const generation = ++listGeneration.current;
    try {
      const response = await api("/v1/member/certificates?limit=25");
      if (!alive.current || generation !== listGeneration.current) return;
      if ([401, 403, 404].includes(response.status)) { setWorkspace({ state: "unauthorized" }); return; }
      if (!response.ok || !validJson(response)) throw new Error();
      const list = CertificateListResponseSchema.parse(await response.json());
      if (alive.current && generation === listGeneration.current) setWorkspace((current) => current.state === "ready"
        ? { ...current, items: list.items, nextCursor: list.nextCursor }
        : current);
    } catch { if (alive.current && generation === listGeneration.current) setAnnouncement("Certificate status could not be refreshed"); }
  }, [api]);

  useEffect(() => {
    alive.current = true;
    const controllers = downloadControllers.current;
    void (async () => {
      try {
        const generation = ++listGeneration.current;
        const [nameResponse, listResponse] = await Promise.all([api("/v1/member/certificate-recipient-name"), api("/v1/member/certificates?limit=25")]);
        if (!alive.current || generation !== listGeneration.current) return;
        if ([401, 403, 404].includes(nameResponse.status) || [401, 403, 404].includes(listResponse.status)) { setWorkspace({ state: "unauthorized" }); return; }
        const name = await parseName(nameResponse);
        if (!listResponse.ok || !validJson(listResponse)) throw new Error("CERTIFICATE_LIST_RESPONSE_INVALID");
        const list = CertificateListResponseSchema.parse(await listResponse.json());
        if (!alive.current || generation !== listGeneration.current) return;
        setWorkspace({ state: "ready", name, items: list.items, nextCursor: list.nextCursor });
        setDraft(name.recipientName?.displayName ?? "");
      } catch { if (alive.current) setWorkspace({ state: "unavailable" }); }
    })();
    return () => {
      alive.current = false;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    };
  }, [api]);

  const hasPending = workspace.state === "ready" && workspace.items.some((item) => item.status === "pending");
  const pollAttempts = useRef(0);
  useEffect(() => {
    if (!hasPending) { pollAttempts.current = 0; return; }
    if (pollAttempts.current >= 12) return;
    const refresh = () => {
      if (pollAttempts.current >= 12) return;
      pollAttempts.current += 1;
      void refreshCertificates();
    };
    const timer = window.setInterval(refresh, 5_000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [hasPending, refreshCertificates]);

  async function refreshName(overwriteDraft: boolean): Promise<void> {
    try {
      const response = await api("/v1/member/certificate-recipient-name");
      if (!alive.current) return;
      if ([401, 403, 404].includes(response.status)) { setWorkspace({ state: "unauthorized" }); return; }
      const name = await parseName(response);
      if (!alive.current || workspace.state !== "ready") return;
      setWorkspace((current) => current.state === "ready" ? { ...current, name } : current);
      const serverName = name.recipientName?.displayName ?? "";
      setComparison(serverName || null);
      if (overwriteDraft) { setDraft(serverName); setNameStatus("idle"); setPendingIntent(null); setAnnouncement("Reloaded the confirmed recipient name"); }
    } catch { if (alive.current) setAnnouncement("The confirmed name could not be reloaded"); }
  }

  async function runNameIntent(next: NameIntent): Promise<void> {
    setNameStatus("saving");
    try {
      const response = await api("/v1/member/certificate-recipient-name", { method: "PUT", headers: { "content-type": "application/json", "idempotency-key": next.key }, body: next.body });
      if (!alive.current) return;
      if (response.ok) {
        const name = await parseName(response);
        if (!alive.current || workspace.state !== "ready") return;
        setWorkspace((current) => current.state === "ready" ? { ...current, name } : current); setDraft(name.recipientName?.displayName ?? ""); setPendingIntent(null); setNameStatus("saved"); setAnnouncement("Recipient name confirmed");
        await refreshCertificates();
        return;
      }
      const code = await errorCode(response);
      if (!alive.current) return;
      if ([401, 403].includes(response.status) || (response.status === 404 && code === "NOT_FOUND")) { setPendingIntent(null); setWorkspace({ state: "unauthorized" }); }
      else if (response.status === 409 && code === "VERSION_CONFLICT") { setPendingIntent(null); setNameStatus("conflict"); setAnnouncement("The recipient name changed in another session. Your unsynced name is preserved."); void refreshName(false); }
      else if (response.status === 409 && code === "IDEMPOTENCY_IN_PROGRESS") setNameStatus("ambiguous");
      else if (response.status >= 400 && response.status < 500) { setPendingIntent(null); setNameStatus("invalid"); setAnnouncement("The recipient name was not saved. Check the field and try again."); }
      else setNameStatus("ambiguous");
    } catch { if (alive.current) setNameStatus("ambiguous"); }
  }

  function confirmName(): void {
    if (workspace.state !== "ready") return;
    try {
      const displayName = canonicalizeCertificateRecipientNameInput(draft);
      const next = { key: intentKey(), body: JSON.stringify({ expectedVersion: workspace.name.recipientName?.version ?? 0, displayName }) };
      setDraft(displayName); setComparison(null); setPendingIntent(next); void runNameIntent(next);
    } catch { setNameStatus("invalid"); setAnnouncement("The recipient name was not saved. Use a supported name of 120 characters or fewer."); }
  }

  async function copyDraft(): Promise<void> {
    try { if (!navigator.clipboard?.writeText) throw new Error(); await navigator.clipboard.writeText(draft); setAnnouncement("Unsynced recipient name copied"); }
    catch { setAnnouncement("The unsynced recipient name could not be copied"); }
  }

  async function loadMore(): Promise<void> {
    if (workspace.state !== "ready" || workspace.nextCursor === null) return;
    const cursor = workspace.nextCursor;
    const generation = ++listGeneration.current;
    try {
      const response = await api(`/v1/member/certificates?limit=25&cursor=${encodeURIComponent(cursor)}`);
      if (!alive.current || generation !== listGeneration.current) return;
      if ([401, 403, 404].includes(response.status)) { setWorkspace({ state: "unauthorized" }); return; }
      if (!response.ok || !validJson(response)) throw new Error();
      const next = CertificateListResponseSchema.parse(await response.json());
      if (alive.current && generation === listGeneration.current) setWorkspace((current) => current.state === "ready"
        ? { ...current, items: [...current.items, ...next.items], nextCursor: next.nextCursor }
        : current);
    } catch { if (alive.current && generation === listGeneration.current) setAnnouncement("More certificates could not be loaded"); }
  }

  async function download(item: CertificateListItem): Promise<void> {
    if (item.status !== "issued") return;
    const controller = new AbortController(); downloadControllers.current.add(controller);
    setDownloadStates((current) => ({ ...current, [item.id]: "downloading" }));
    try {
      const response = await api(`/v1/member/certificates/${item.id}/download`, { signal: controller.signal });
      if (!alive.current) return;
      if ([401, 403, 404].includes(response.status)) { setWorkspace({ state: "unauthorized" }); return; }
      if (!response.ok || response.headers.get("content-type") !== "application/pdf") throw new Error();
      const contentLength = Number(response.headers.get("content-length"));
      if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > 25 * 1_024 * 1_024) throw new Error();
      const blob = await response.blob();
      if (!alive.current || blob.size !== contentLength || blob.type !== "application/pdf") return;
      const url = URL.createObjectURL(blob);
      try { const anchor = document.createElement("a"); anchor.href = url; anchor.download = "syntholo-certificate-of-completion.pdf"; anchor.rel = "noreferrer"; anchor.click(); }
      finally { URL.revokeObjectURL(url); }
      setDownloadStates((current) => ({ ...current, [item.id]: "idle" })); setAnnouncement("Private certificate download started");
    } catch { if (alive.current && !controller.signal.aborted) setDownloadStates((current) => ({ ...current, [item.id]: "failed" })); }
    finally { downloadControllers.current.delete(controller); }
  }

  if (workspace.state === "loading") return <main className="state-page" role="status"><h1>Loading certificate settings</h1></main>;
  if (workspace.state === "unauthorized") return <main className="state-page" role="alert"><h1>Certificate settings unavailable</h1><p>Sign in again to view this private workspace.</p></main>;
  if (workspace.state === "unavailable") return <main className="state-page" role="alert"><h1>Certificate settings unavailable</h1><p>Try again in a moment.</p></main>;

  const confirmed = workspace.name.recipientName;
  const locked = nameStatus === "saving" || nameStatus === "ambiguous";
  return (
    <main className="member-page production-certificate-settings">
      <header className="production-certificate-heading"><span className="micro-label">Private completion record</span><h1>Certificate settings</h1><p>Unaccredited certificate of completion</p></header>
      <section aria-labelledby="certificate-name-title" className="production-certificate-name-card">
        <div><ShieldCheck aria-hidden="true" size={22} /><span className="micro-label">Recipient identity</span><h2 id="certificate-name-title">Name on your certificate</h2><p>Confirm the exact name you want on private certificates. We never infer it from email or account details.</p></div>
        <div className="production-certificate-name-form">
          <label htmlFor="certificate-recipient-name">Recipient name</label>
          <input aria-describedby="certificate-name-help" aria-invalid={nameStatus === "invalid"} disabled={locked} id="certificate-recipient-name" maxLength={1_024} onChange={(event) => { setDraft(event.target.value); setNameStatus("idle"); }} value={draft} />
          <small id="certificate-name-help">Up to 120 supported characters after whitespace is normalized.</small>
          <button className="button button-primary button-medium" disabled={locked || draft.length === 0} onClick={confirmName} type="button">{nameStatus === "saving" ? "Confirming name" : confirmed ? "Update recipient name" : "Confirm recipient name"}</button>
          {nameStatus === "ambiguous" && pendingIntent ? <button className="button button-quiet button-medium" onClick={() => void runNameIntent(pendingIntent)} type="button">Retry exact confirmation</button> : null}
        </div>
        {nameStatus === "conflict" ? <div className="production-certificate-conflict" role="alert"><strong>The recipient name changed in another session. Your unsynced name is preserved.</strong><p>Your unsynced name: {draft}</p><p>Server-confirmed name: {comparison ?? "Comparison unavailable"}</p><div><button onClick={() => void copyDraft()} type="button">Copy unsynced name</button><button onClick={() => void refreshName(true)} type="button">Reload confirmed name</button></div></div> : null}
      </section>
      <section aria-labelledby="certificate-list-title" className="production-certificate-list-section">
        <div className="production-certificate-list-heading"><div><FileCheck2 aria-hidden="true" size={22} /><h2 id="certificate-list-title">Your completion certificates</h2></div><p>One private certificate is shown for each eligible personal completion.</p></div>
        {workspace.items.length === 0 ? <p className="production-certificate-empty">No eligible course completions yet.</p> : <div className="production-certificate-grid">{workspace.items.map((item) => <CertificateCard download={(value) => void download(value)} downloadState={downloadStates[item.id] ?? "idle"} item={item} key={item.id} />)}</div>}
        {workspace.nextCursor ? <button className="button button-quiet button-medium" onClick={() => void loadMore()} type="button">Load more certificates</button> : null}
      </section>
      <p aria-live="polite" className="sr-only">{announcement || (nameStatus === "saved" ? "Recipient name confirmed" : nameStatus === "ambiguous" ? "Confirmation result unknown. Retry uses the exact same request." : "")}</p>
    </main>
  );
}

export function ProductionCertificateSettings() {
  const auth = useAuth();
  if (!auth.isLoaded || auth.isSignedIn === undefined) return <main className="state-page" role="status"><h1>Loading certificate settings</h1></main>;
  if (!auth.isSignedIn || !auth.sessionId) return <main className="state-page" role="alert"><h1>Certificate settings unavailable</h1><p>Sign in to view this private workspace.</p></main>;
  return <CertificateWorkspace getToken={auth.getToken} key={auth.sessionId} />;
}
