import { BusinessOsOnboarding } from "@/features/business-os/business-os-onboarding";
import { demoSoftwareAccount } from "@/lib/demo/data";

export default function BusinessOsPage() {
  return <div className="member-page business-os-page"><section className="page-intro"><div><span className="eyebrow"><span className="eyebrow-dot" /> Optional implementation service</span><h1>Business OS</h1><p>Your Academy workflows, configured into one managed lead and client operating system.</p></div><div className="os-offer-price"><span>$999 setup</span><strong>$199/month</strong></div></section><BusinessOsOnboarding initialAccount={demoSoftwareAccount} /></div>;
}
