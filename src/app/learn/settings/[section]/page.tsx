import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";

export default async function SettingsSectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (section !== "billing") notFound();
  return <div className="member-page simple-page"><span className="eyebrow"><span className="eyebrow-dot" /> Access and billing</span><h1>Your plan</h1><p>Lifetime Academy access remains active. Human support and community write access continue through July 30, 2027.</p><div className="settings-grid"><section><span className="micro-label">Academy</span><h2>AI Operating System Academy</h2><p>Paid in full · 3 seats · lifetime course access</p><Button size="small" variant="secondary">Download receipt</Button></section><section><span className="micro-label">Optional services</span><h2>No active subscription</h2><p>Business OS and Operator Club can be added independently.</p><Button size="small" variant="secondary">Review options</Button></section></div></div>;
}
