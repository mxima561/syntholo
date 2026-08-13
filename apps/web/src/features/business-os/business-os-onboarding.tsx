"use client";

import { useMemo, useState } from "react";
import { ArrowRight, Check, CheckCircle2, Clock3, ShieldCheck } from "lucide-react";
import type { SoftwareAccount } from "@/lib/domain/types";
import { Button } from "@/components/ui/button";
import { transitionProvisioning } from "./provisioning";

const capabilities = [
  ["Lead command center", "Capture, qualify, route, and follow up from one place."],
  ["Client experience", "Launch consistent booking, onboarding, and communication."],
  ["Owner visibility", "See pipeline, response, booking, and activity measures."],
];

export function BusinessOsOnboarding({ initialAccount }: { initialAccount: SoftwareAccount }) {
  const [account, setAccount] = useState(initialAccount);
  const percent = useMemo(() => Math.round((account.checklist.filter((item) => item.complete).length / account.checklist.length) * 100), [account.checklist]);

  function toggle(id: string) {
    setAccount((current) => ({ ...current, checklist: current.checklist.map((item) => item.id === id ? { ...item, complete: !item.complete } : item) }));
  }

  function submit() {
    const result = transitionProvisioning({ status: account.status, questionnairePercent: percent, action: "start_provisioning", now: new Date("2026-08-11T16:00:00.000Z") });
    if ("provisioningStartedAt" in result && result.provisioningStartedAt && result.provisioningDueAt) {
      setAccount((current) => ({ ...current, status: result.status, provisioningStartedAt: result.provisioningStartedAt.toISOString(), provisioningDueAt: result.provisioningDueAt.toISOString() }));
    }
  }

  if (account.status === "provisioning") {
    return <section className="provisioning-success"><span><CheckCircle2 size={24} /></span><div><span className="micro-label">Setup in progress</span><h2>Provisioning has started.</h2><p>Our operations team is configuring and testing your Business OS. Your target activation date is August 18, 2026.</p><div><span><Clock3 size={13} /> Five-business-day service level</span><span><ShieldCheck size={13} /> Seven launch checks before activation</span></div></div><Button size="small" variant="secondary">View setup status <ArrowRight size={14} /></Button></section>;
  }

  return (
    <div className="business-os-layout">
      <section className="business-os-overview">
        <div className="os-blueprint"><div className="os-command-bar"><span className="brand-mark">S</span><div><small>NORTHSTAR COMMAND CENTER</small><strong>Good morning, Maria</strong></div><i>LIVE</i></div><div className="os-metric-grid"><article><span>New leads</span><strong>18</strong><small>↑ 22% this month</small></article><article><span>Median response</span><strong>6m</strong><small>Target under 10m</small></article><article><span>Booked calls</span><strong>11</strong><small>61% conversion</small></article></div><div className="os-pipeline"><span>NEW LEAD</span><i /><span>QUALIFIED</span><i /><span>BOOKED</span><i /><span>CLIENT</span></div></div>
        <span className="micro-label">Your implementation layer</span><h2>A managed system for the workflows you build in the Academy.</h2><p>Syntholo Business OS is our white-label implementation service built on HighLevel. We configure, test, and support it for your business.</p><div className="capability-list">{capabilities.map(([title, copy], index) => <article key={title}><span>0{index + 1}</span><div><strong>{title}</strong><p>{copy}</p></div></article>)}</div><div className="partner-disclosure"><ShieldCheck size={16} /><p><strong>Clear relationship:</strong> Syntholo provides the configuration and support. The underlying software platform is HighLevel. The $199 monthly subscription renews until canceled.</p></div>
      </section>
      <aside className="onboarding-panel"><div className="onboarding-head"><span className="micro-label">Setup questionnaire</span><h2>Tell us how your business works.</h2><p>Provisioning begins after every section is complete.</p><div><span>{percent}% complete</span><i><b style={{ width: `${percent}%` }} /></i></div></div><div className="onboarding-checklist">{account.checklist.map((item, index) => <label key={item.id}><input aria-label={item.label} checked={item.complete} onChange={() => toggle(item.id)} type="checkbox" /><span>{item.complete ? <Check size={13} /> : index + 1}</span><div><strong>{item.label}</strong><small>{item.complete ? "Complete" : "Needs your input"}</small></div><ArrowRight size={14} /></label>)}</div><Button disabled={percent < 100} onClick={submit} variant="milestone">Submit for provisioning <ArrowRight size={14} /></Button><small className="onboarding-note">Missing access or third-party verification pauses the five-business-day clock.</small></aside>
    </div>
  );
}
