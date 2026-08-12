import Link from "next/link";
import { ArrowRight, CalendarDays, Check, Clock3, FileCheck2, MessageSquareText, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { getDashboard } from "@/lib/demo/repository";

const engineMeta = [
  { name: "Growth engine", description: "Lead response and routing", state: "Live", tone: "coral" },
  { name: "Client engine", description: "Consistent onboarding", state: "Testing", tone: "teal" },
  { name: "Management engine", description: "Weekly owner brief", state: "Draft", tone: "gold" },
];

export default function LearnDashboardPage() {
  const dashboard = getDashboard("member-maria");
  const activeThread = dashboard.supportThreads[0];
  const session = dashboard.upcomingSession;

  return (
    <div className="member-page dashboard-page">
      <section className="page-intro">
        <div><span className="eyebrow"><span className="eyebrow-dot" /> Monday, August 11</span><h1>Good evening, {dashboard.member.firstName}.</h1><p>One focused action keeps your team moving this week.</p></div>
        <Button href="/learn/plan" variant="secondary">Open 30-day plan <ArrowRight size={15} /></Button>
      </section>

      <div className="dashboard-grid">
        <div className="dashboard-primary">
          <section className="next-action-card">
            <div className="next-action-copy"><span className="micro-label light">Your next best action</span><h2>Build your qualification rules</h2><p>Finish lesson 8 and turn your lead criteria into a simple routing workflow your team can test.</p><div className="action-meta"><span><Clock3 size={14} /> 12 min lesson</span><span><FileCheck2 size={14} /> 1 business output</span></div><Button href={dashboard.nextAction.href} variant="secondary">Continue lesson <ArrowRight size={15} /></Button></div>
            <div className="action-map"><span>NOW</span><i /><div><strong>Respond</strong><small>In seconds</small></div><i /><div><strong>Qualify</strong><small>By fit</small></div><i /><div><strong>Route</strong><small>To an owner</small></div></div>
          </section>

          <section className="dashboard-section">
            <div className="section-title-row"><div><span className="micro-label">Your program</span><h2>Build progress</h2></div><Link className="text-link" href="/learn/course">View course <ArrowRight size={13} /></Link></div>
            <div className="progress-card"><div><strong>{dashboard.progressPercent}%</strong><span>complete</span></div><Progress label={`${dashboard.completedCount} of 18 lessons`} value={dashboard.progressPercent} /><p>Stage 3 of 6 · Building your growth engine</p></div>
          </section>

          <section className="dashboard-section">
            <div className="section-title-row"><div><span className="micro-label">Operating system</span><h2>Your three business engines</h2></div><Link className="text-link" href="/learn/workflows">Manage workflows <ArrowRight size={13} /></Link></div>
            <div className="engine-card-grid">{engineMeta.map((engine, index) => <article key={engine.name}><span className={`engine-icon ${engine.tone}`}><Workflow size={17} /></span><div><small>0{index + 1}</small><h3>{engine.name}</h3><p>{engine.description}</p></div><i className={`status-pill ${engine.state.toLowerCase()}`}>{engine.state}</i></article>)}</div>
          </section>

          <section className="dashboard-section">
            <div className="section-title-row"><div><span className="micro-label">Business outputs</span><h2>Artifacts your team can use</h2></div><Link className="text-link" href="/learn/plan">Open workspace <ArrowRight size={13} /></Link></div>
            <div className="artifact-list">{dashboard.artifacts.slice(0, 3).map((artifact) => <Link href={`/learn/plan?artifact=${artifact.id}`} key={artifact.id}><span className={`artifact-state ${artifact.status}`}><Check size={13} /></span><div><strong>{artifact.title}</strong><small>Version {artifact.version} · {artifact.updatedBy}</small></div><i className={`status-pill ${artifact.status}`}>{artifact.status.replace("_", " ")}</i><ArrowRight size={15} /></Link>)}</div>
          </section>
        </div>

        <aside className="dashboard-rail">
          <section className="rail-card live-card"><div className="rail-card-head"><span className="coach-avatar">NR</span><div><span className="online-dot" /> Human coaching</div></div><h2>Naomi is here to help.</h2><p>Bring a decision, draft, or workflow. You will hear from a real practitioner within two business days.</p><Button href="/learn/support" size="small">Ask a human coach <MessageSquareText size={14} /></Button></section>
          {session ? <section className="rail-card"><span className="micro-label">Next live session</span><div className="session-date"><strong>13</strong><span>AUG<br />THU</span></div><h2>{session.title}</h2><p>Hosted by {session.hostName} · 1:00 PM ET</p><Button href="/learn/live" size="small" variant="secondary"><CalendarDays size={14} /> View session</Button></section> : null}
          <section className="rail-card coach-reply"><span className="micro-label">Coach replied</span><h2>{activeThread.subject}</h2><p>“{activeThread.messages.at(-1)?.body}”</p><Link className="text-link" href={`/learn/support?thread=${activeThread.id}`}>Read and reply <ArrowRight size={13} /></Link></section>
        </aside>
      </div>
    </div>
  );
}
