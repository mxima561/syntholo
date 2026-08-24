import { ArrowRight, Check, Minus } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

const plans = [
  {
    id: "self-paced",
    label: "Self-paced academy",
    price: "$399",
    detail: "One-time · 3 seats",
    description: "Move through the full 30-day system on your schedule, with a year of real human support.",
    included: ["Lifetime course access and updates", "Three business seats", "Monthly live office hours", "Human coach inbox for 12 months", "Active community for 12 months"],
    featured: true,
  },
  {
    id: "operator-club",
    label: "Operator Club",
    price: "$59",
    detail: "Per month · 3 seats",
    description: "Stay current, keep your implementation moving, and continue learning with other owners.",
    included: ["Monthly implementation playbook", "Two live office-hours times", "Human coach inbox", "Active professional community", "Tool and platform updates"],
    featured: false,
  },
] as const;

export default function PricingPage() {
  return (
    <main className="pricing-page">
      <header className="site-header shell">
        <Link className="brand" href="/"><span className="brand-mark">S</span><span>Syntholo</span></Link>
        <Button href={{ pathname: "/sign-in" }} size="small" variant="quiet">Member sign in</Button>
      </header>
      <section className="pricing-hero shell">
        <span className="micro-label">SIMPLE OPTIONS, CLEAR OUTCOMES</span>
        <h1>Start with the academy.<br />Keep building when you are ready.</h1>
        <p>Every academy purchase includes your owner workspace and two teammate seats. You never need to buy software to complete the course.</p>
      </section>
      <section className="pricing-grid shell">
        {plans.map((plan) => (
          <article className={`pricing-card ${plan.featured ? "featured" : ""}`} key={plan.id}>
            <div className="plan-topline"><span>{plan.label}</span>{plan.featured ? <i>Best place to start</i> : null}</div>
            <div className="plan-price"><strong>{plan.price}</strong><span>{plan.detail}</span></div>
            <p>{plan.description}</p>
            <ul>{plan.included.map((item) => <li key={item}><Check aria-hidden size={14} />{item}</li>)}</ul>
            <Button href="/" size="large" variant={plan.featured ? "primary" : "dark"}>Choose {plan.label.toLowerCase()} <ArrowRight aria-hidden size={16} /></Button>
          </article>
        ))}
      </section>
      <section className="business-os-offer shell">
        <div><span className="micro-label light">OPTIONAL SOFTWARE UPSELL</span><h2>Want the system installed for you?</h2><p>Syntholo Business OS gives you a configured, separately branded HighLevel workspace after the academy helps you decide what should be built.</p></div>
        <div className="os-price"><span>Setup</span><strong>$999</strong><Minus aria-hidden size={14} /><span>Then</span><strong>$199/mo</strong><Button href="/" variant="secondary">Review the package</Button></div>
      </section>
      <div className="pricing-note shell">Prices are USD. Usage-based messaging, phone, and AI charges for Business OS are separate and disclosed before purchase.</div>
    </main>
  );
}
