import Link from "next/link";
import { WaitlistForm } from "@/components/waitlist-form";
import { Button } from "@/components/ui/button";

export default function HomePage() {
  return (
    <main className="marketing-page">
      <header className="site-header shell">
        <Link aria-label="Syntholo home" className="brand" href="/">
          <span className="brand-mark">S</span>
          <span>Syntholo</span>
        </Link>
        <div className="header-actions">
          <Button href={{ pathname: "/sign-in" }} size="small" variant="quiet">
            Member sign in
          </Button>
          <Button href="/scorecard" size="small" variant="secondary">
            Take the scorecard
          </Button>
        </div>
      </header>

      <section className="hero shell waitlist-hero">
        <div className="hero-copy">
          <WaitlistForm />
        </div>
      </section>

      <footer className="site-footer shell">
        <Link className="brand" href="/"><span className="brand-mark">S</span><span>Syntholo</span></Link>
        <p>A practical school for using AI in life and business.</p>
        <div><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><a href="mailto:hello@syntholo.com">Contact</a></div>
      </footer>
    </main>
  );
}
