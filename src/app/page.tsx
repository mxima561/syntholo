import {
  ArrowRight,
  CalendarCheck2,
  Check,
  ChevronRight,
  ShieldCheck,
  Sparkles,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

const outcomes = [
  {
    icon: ShieldCheck,
    label: "A safe starting point",
    text: "Know which tools your team can use, which data stays private, and who owns each workflow.",
  },
  {
    icon: Workflow,
    label: "Three working systems",
    text: "Launch practical workflows for growth, client delivery, and the way you manage the business.",
  },
  {
    icon: CalendarCheck2,
    label: "A 90-day roadmap",
    text: "Leave with owners, measures, and the next improvements already mapped—not a folder of unused prompts.",
  },
];

export default function HomePage() {
  return (
    <main className="marketing-page">
      <header className="site-header shell">
        <Link aria-label="Syntholo home" className="brand" href="/">
          <span className="brand-mark">S</span>
          <span>Syntholo</span>
        </Link>
        <nav aria-label="Main navigation" className="desktop-nav">
          <a href="#program">Program</a>
          <a href="#outcomes">Outcomes</a>
          <Link href="/pricing">Pricing</Link>
        </nav>
        <div className="header-actions">
          <Button href="/learn" size="small" variant="quiet">
            Member sign in
          </Button>
          <Button href="/scorecard" size="small">
            Take the scorecard
          </Button>
        </div>
      </header>

      <section className="hero shell">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="eyebrow-dot" /> AI Operating System Academy
          </div>
          <h1 aria-label="Put AI to work across your business.">
            Put AI to work
            <br />
            across your business.
          </h1>
          <p className="hero-lede">
            A 30-day implementation program for professional-services owners. Build safe rules,
            launch three useful workflows, and bring your team with you.
          </p>
          <div className="hero-actions">
            <Button href="/scorecard" size="large">
              Take the free scorecard <ArrowRight aria-hidden size={17} />
            </Button>
            <a className="text-link" href="#program">
              Explore the 30-day plan <ChevronRight aria-hidden size={15} />
            </a>
          </div>
          <div className="hero-proof">
            <div className="avatar-stack" aria-hidden>
              <span>MK</span><span>AJ</span><span>SR</span>
            </div>
            <p><strong>Built for owners, not technologists.</strong><br />Three seats included for your team.</p>
          </div>
        </div>

        <div className="blueprint" aria-label="A preview of the 30-day operating blueprint">
          <div className="blueprint-topline">
            <span>YOUR 30-DAY OPERATING BLUEPRINT</span>
            <span className="live-status"><i /> READY TO START</span>
          </div>
          <div className="blueprint-path" aria-hidden>
            <span className="path-line" />
            <span className="path-node active">1</span>
            <span className="path-node">2</span>
            <span className="path-node">3</span>
            <span className="path-node">4</span>
          </div>
          <div className="blueprint-heading">
            <div>
              <span className="micro-label">Week one</span>
              <h2>Find the work worth changing.</h2>
            </div>
            <span className="score-badge">Readiness<br /><strong>64</strong></span>
          </div>
          <div className="engine-preview">
            <div className="engine-row active">
              <span className="engine-icon coral"><Sparkles aria-hidden size={15} /></span>
              <span><strong>Growth engine</strong><small>Lead response selected</small></span>
              <span className="engine-state">FIRST WIN</span>
            </div>
            <div className="engine-row">
              <span className="engine-icon teal"><Workflow aria-hidden size={15} /></span>
              <span><strong>Client engine</strong><small>Onboarding mapped</small></span>
              <Check aria-hidden className="check" size={16} />
            </div>
            <div className="engine-row">
              <span className="engine-icon gold"><CalendarCheck2 aria-hidden size={15} /></span>
              <span><strong>Management engine</strong><small>Unlocks in week three</small></span>
              <span className="muted-status">NEXT</span>
            </div>
          </div>
          <div className="coach-note">
            <span className="coach-avatar">NR</span>
            <p><strong>A real coach is here when you need one.</strong><br />Bring your workflow to live office hours or ask for feedback.</p>
          </div>
        </div>
      </section>

      <section className="outcomes-section" id="outcomes">
        <div className="shell">
          <div className="section-heading split-heading">
            <div>
              <span className="micro-label">WHAT CHANGES</span>
              <h2>From scattered experiments<br />to one operating rhythm.</h2>
            </div>
            <p>The course teaches the decisions. Your workspace turns those decisions into assets the team can actually run.</p>
          </div>
          <div className="outcome-grid">
            {outcomes.map(({ icon: Icon, label, text }, index) => (
              <article className="outcome-card" key={label}>
                <div className="outcome-index">0{index + 1}</div>
                <Icon aria-hidden size={21} />
                <h3>{label}</h3>
                <p>{text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="program-section shell" id="program">
        <div className="program-copy">
          <span className="micro-label">THE FLAGSHIP PROGRAM</span>
          <h2>A working system in four focused weeks.</h2>
          <p>Watch short lessons when it suits you. Build with your team. Get unstuck with real people.</p>
          <Button href="/pricing" variant="dark">
            See program options <ArrowRight aria-hidden size={16} />
          </Button>
        </div>
        <ol className="week-list">
          <li><span>01</span><div><strong>Diagnose + set the rules</strong><small>Map the business, choose opportunities, and write the team AI policy.</small></div></li>
          <li><span>02</span><div><strong>Build the growth engine</strong><small>Capture, qualify, schedule, and follow up without leads slipping away.</small></div></li>
          <li><span>03</span><div><strong>Improve client + management work</strong><small>Systemize onboarding, communication, reporting, and follow-through.</small></div></li>
          <li><span>04</span><div><strong>Launch + plan the next 90 days</strong><small>Test three workflows, train the team, and measure what changes.</small></div></li>
        </ol>
      </section>

      <section className="final-cta shell">
        <div>
          <span className="micro-label light">START WITH CLARITY</span>
          <h2>Find your first useful AI workflow.</h2>
          <p>The free readiness scorecard takes about six minutes and gives you a practical place to begin.</p>
        </div>
        <Button href="/scorecard" size="large" variant="secondary">
          Take the free scorecard <ArrowRight aria-hidden size={17} />
        </Button>
      </section>

      <footer className="site-footer shell">
        <Link className="brand" href="/"><span className="brand-mark">S</span><span>Syntholo</span></Link>
        <p>AI systems for businesses run by humans.</p>
        <div><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><a href="mailto:hello@syntholo.com">Contact</a></div>
      </footer>
    </main>
  );
}
