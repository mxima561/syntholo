import { ProductionCertificateSettings } from "@/components/production-certificate-settings";
import { isDemoMode } from "@/lib/config/mode";

export default async function CertificateSettingsPage() {
  if (!isDemoMode()) return <ProductionCertificateSettings />;
  return <main className="member-page"><h1>Certificate settings</h1><p>Certificate settings are available in the signed-in production workspace.</p></main>;
}
