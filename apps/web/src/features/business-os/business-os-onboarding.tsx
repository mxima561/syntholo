"use client";

import { useMemo, useState, useTransition } from "react";
import { ArrowRight, Check, CheckCircle2, Clock3, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { submitSoftwareAction, toggleSoftwareItemAction } from "@/app/learn/actions";
import { transitionProvisioning } from "./provisioning";

const capabilities = [
  ["Lead command center", "Capture, qualify, route, and follow up from one place."],
  ["Client experience", "Launch consistent booking, onboarding, and communication."],
  ["Owner visibility", "See pipeline, response, booking, and activity measures."],
];

export type OnboardingAccount = {
  id: string;
  firstName: string;
  status: "pending_onboarding" | "provisioning" | "active" | "paused" | "canceled";
  provisioningDueAt: string | null;
  checklist: Array<{ id: string; label: string; complete: boolean }>;
};

export function BusinessOsOnboarding({ initialAccount }: { initialAccount: OnboardingAccount }) {
  const [account, setAccount] = useState(initialAccount);
  const [pending, startTransition] = useTransition();
  const percent = useMemo(() => Math.round((account.checklist.filter((item) => item.complete).length / Math.max(account.checklist.length, 1)) * 100), [account.checklist]);

  function toggle(id: string) {
    setAccount((current) => ({
      ...current,
      checklist: current.checklist.map((item) => item.id === id ? { ...item, complete: !item.complete } : item),
    }));
    startTransition(async () => {
      await toggleSoftwareItemAction(id);
    });
  }

  function submit() {
    const result = transitionProvisioning({
      status: account.status,
      questionnairePercent: percent,
      action: "start_provisioning",
      now: new Date(),
    });
    if ("provisioningStartedAt" in result && result.provisioningStartedAt && result.provisioningDueAt) {
      setAccount((current) => ({
        ...current,
        status: result.status,
        provisioningDueAt: result.provisioningDueAt.toISOString(),
      }));
    }
    startTransition(async () => {
      await submitSoftwareAction();
    });
  }

  if (account.status === "provisioning" || account.status === "active") {
    const due = account.provisioningDueAt
      ? new Date(account.provisioningDueAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
      : "within five business days";
    return (
      <section className="provisioning-success">
        <span><CheckCircle2 size={24} /></span>
        <div>
          <span className="micro-label">{account.status === "active" ? "Live" : "Setup in progress"}</span>
          <h2>{account.status === "active" ? "Your Business OS is active." : "Provisioning has started."}</h2>
          <p>{account.status === "active" ? "Operations completed the seven launch checks. Use your HighLevel login from the activation email." : `Our operations team is configuring and testing your Business OS. Target activation is ${due}.`}</p>
          <div>
            <span><Clock3 size={13} /> Five-business-day service level</span>
            <span><ShieldCheck size={13} /> Seven launch checks before activation</span>
          </div>
        </div>
      </section>
    );
  }

  return (
    <div className="business-os-layout">
      <section className="business-os-overview">
        <div className="os-blueprint">
          <div className="os-command-bar">
            <span className="brand-mark">S</span>
            <div><small>YOUR COMMAND CENTER</small><strong>Good morning, {account.firstName || "there"}</strong></div>
            <i>SETUP</i>
          </div>
          <div className="os-metric-grid">
            <article><span>New leads</span><strong>—</strong><small>Appear after activation</small></article>
            <article><span>Median response</span><strong>—</strong><small>Measured on live traffic</small></article>
            <article><span>Booked calls</span><strong>—</strong><small>Measured on live traffic</small></article>
          </div>
          <div className="os-pipeline"><span>NEW LEAD</span><i /><span>QUALIFIED</span><i /><span>BOOKED</span><i /><span>CLIENT</span></div>
        </div>
        <span className="micro-label">Your implementation layer</span>
        <h2>A managed system for the workflows you build in the Academy.</h2>
        <p>Syntholo Business OS is our white-label implementation service built on HighLevel. We configure, test, and support it for your business.</p>
        <div className="capability-list">{capabilities.map(([title, copy], index) => <article key={title}><span>0{index + 1}</span><div><strong>{title}</strong><p>{copy}</p></div></article>)}</div>
        <div className="partner-disclosure"><ShieldCheck size={16} /><p><strong>Clear relationship:</strong> Syntholo provides the configuration and support. The underlying software platform is HighLevel. The $199 monthly subscription renews until canceled.</p></div>
      </section>
      <aside className="onboarding-panel">
        <div className="onboarding-head">
          <span className="micro-label">Setup questionnaire</span>
          <h2>Tell us how your business works.</h2>
          <p>Provisioning begins after every section is complete.</p>
          <div><span>{percent}% complete</span><i><b style={{ width: `${percent}%` }} /></i></div>
        </div>
        <div className="onboarding-checklist">{account.checklist.map((item, index) => (
          <label key={item.id}>
            <input aria-label={item.label} checked={item.complete} disabled={pending} onChange={() => toggle(item.id)} type="checkbox" />
            <span>{item.complete ? <Check size={13} /> : index + 1}</span>
            <div><strong>{item.label}</strong><small>{item.complete ? "Complete" : "Needs your input"}</small></div>
            <ArrowRight size={14} />
          </label>
        ))}</div>
        <Button disabled={pending || percent < 100} onClick={submit} variant="milestone">Submit for provisioning <ArrowRight size={14} /></Button>
        <small className="onboarding-note">Missing access or third-party verification pauses the five-business-day clock.</small>
      </aside>
    </div>
  );
}
