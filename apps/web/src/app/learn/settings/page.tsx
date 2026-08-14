import { Button } from "@/components/ui/button";
import { ProductionMemberAccess } from "@/components/production-member-access";
import { isDemoMode } from "@/lib/config/mode";

export default function SettingsPage() {
  if (!isDemoMode()) return <ProductionMemberAccess />;
  return <div className="member-page simple-page"><span className="eyebrow"><span className="eyebrow-dot" /> Workspace</span><h1>Settings</h1><div className="settings-grid"><section><span className="micro-label">Profile</span><h2>Maria Chen</h2><p>Founder · Northstar Advisory</p><Button size="small" variant="secondary">Edit profile</Button></section><section><span className="micro-label">Access</span><h2>Academy + support</h2><p>Lifetime course access. Human support active through July 30, 2027.</p><Button size="small" variant="secondary">Manage team</Button></section></div></div>;
}
