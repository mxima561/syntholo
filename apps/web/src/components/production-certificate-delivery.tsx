"use client";

import {
  CertificateDeliveryResponseSchema,
  CreateCertificateDeliveryRequestSchema,
} from "@syntholo/contracts/learning";
import { ApiErrorSchema } from "@syntholo/contracts/http";
import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { createStaffApiClient } from "@/lib/api/client";

type Intent = Readonly<{ certificateId: string; body: string; key: string }>;
type State = "idle" | "submitting" | "ambiguous" | "pending" | "invalid" | "failed";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function intentKey(): string { return `certificate-delivery-${globalThis.crypto.randomUUID()}`; }

async function responseCode(response: Response): Promise<string | null> {
  if (!/^application\/json(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) return null;
  try {
    const parsed = ApiErrorSchema.safeParse(await response.clone().json());
    return parsed.success ? parsed.data.error.code : null;
  } catch { return null; }
}

export function ProductionCertificateDelivery() {
  const [certificateId, setCertificateId] = useState("");
  const [reason, setReason] = useState("");
  const [state, setState] = useState<State>("idle");
  const [intent, setIntent] = useState<Intent | null>(null);
  const api = createStaffApiClient();

  async function run(next: Intent): Promise<void> {
    setState("submitting");
    try {
      const response = await api(`/v1/staff/certificates/${next.certificateId}/deliveries`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": next.key,
          "x-syntholo-csrf": "1",
        },
        body: next.body,
      });
      if (response.ok) {
        if (!/^application\/json(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) throw new Error();
        CertificateDeliveryResponseSchema.parse(await response.json());
        setIntent(null);
        setState("pending");
        return;
      }
      const code = await responseCode(response);
      if (response.status >= 500 || (response.status === 409 && code === "IDEMPOTENCY_IN_PROGRESS")) {
        setState("ambiguous");
      } else if (response.status === 400) {
        setIntent(null);
        setState("invalid");
      } else {
        setIntent(null);
        setState("failed");
      }
    } catch {
      setState("ambiguous");
    }
  }

  function submit(): void {
    const parsed = CreateCertificateDeliveryRequestSchema.safeParse({ reason });
    if (!uuid.test(certificateId) || !parsed.success) {
      setState("invalid");
      return;
    }
    const next = { certificateId, body: JSON.stringify(parsed.data), key: intentKey() };
    setIntent(next);
    void run(next);
  }

  const locked = state === "submitting" || state === "ambiguous" || state === "pending";
  return (
    <div className="admin-page production-certificate-delivery">
      <section className="admin-page-head"><div><span className="micro-label">Certificate recovery</span><h1>Private certificate delivery</h1><p>Record an audited delivery recovery request for an issued private certificate.</p></div></section>
      <section aria-labelledby="certificate-delivery-form-title" className="certificate-delivery-panel">
        <div><RotateCcw aria-hidden="true" size={22} /><h2 id="certificate-delivery-form-title">Request delivery recovery</h2><p>This creates a pending recovery fact only. It does not collect a destination or send email.</p></div>
        <div className="certificate-delivery-form">
          <label>Certificate ID<input aria-invalid={state === "invalid"} disabled={locked} onChange={(event) => { setCertificateId(event.target.value); setState("idle"); }} value={certificateId} /></label>
          <label>Recovery reason<textarea aria-invalid={state === "invalid"} disabled={locked} onChange={(event) => { setReason(event.target.value); setState("idle"); }} value={reason} /></label>
          <button className="button button-primary button-medium" disabled={locked} onClick={submit} type="button">{state === "submitting" ? "Requesting recovery" : "Request delivery recovery"}</button>
          {state === "ambiguous" && intent ? <button className="button button-quiet button-medium" onClick={() => void run(intent)} type="button">Retry exact request</button> : null}
        </div>
        {state === "pending" ? <div className="certificate-delivery-result" role="status"><strong>Delivery pending</strong><p>No email has been sent in this release.</p></div> : null}
        {state === "invalid" ? <p className="certificate-delivery-error" role="alert">The request was not sent. Enter a valid certificate ID and recovery reason.</p> : null}
        {state === "failed" ? <p className="certificate-delivery-error" role="alert">The request was not sent. The certificate is unavailable or you are not authorized.</p> : null}
      </section>
    </div>
  );
}
