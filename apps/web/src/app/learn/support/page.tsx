import { SupportInbox } from "@/features/support/support-inbox";
import { demoSupportThreads } from "@/lib/demo/data";

export default function SupportPage() {
  return <div className="member-page support-page"><section className="page-intro"><div><span className="eyebrow"><span className="eyebrow-dot" /> Real practitioner support</span><h1>Your human support inbox</h1><p>Your whole team can see the context, questions, files, and coach replies.</p></div></section><SupportInbox initialThreads={demoSupportThreads} /></div>;
}
