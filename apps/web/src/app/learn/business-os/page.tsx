import { BusinessOsOnboarding } from "@/features/business-os/business-os-onboarding";
import { requireAcademyAccess } from "@/lib/server/accounts";
import { getSoftwareAccount } from "@syntholo/db";

export const dynamic = "force-dynamic";

export default async function BusinessOsPage() {
  const { account, access } = await requireAcademyAccess();
  const software = await getSoftwareAccount(account.id);
  return (
    <div className="member-page business-os-page">
      <section className="page-intro">
        <div>
          <span className="eyebrow"><span className="eyebrow-dot" /> Optional implementation service</span>
          <h1>Business OS</h1>
          <p>Your Academy workflows, configured into one managed lead and client operating system.</p>
        </div>
        <div className="os-offer-price"><span>$999 setup</span><strong>$199/month</strong></div>
      </section>
      {software ? (
        <BusinessOsOnboarding
          canActivate={access.capabilities.business_os && !access.holds.includes("business_os_activation")}
          lockedMessage={
            !access.capabilities.business_os
              ? "Business OS is a separate service. Academy access does not include activation."
              : "Business OS activation is on hold for this account."
          }
          initialAccount={{
            id: software.id,
            firstName: account.firstName,
            status: software.status,
            provisioningDueAt: software.provisioningDueAt?.toISOString() ?? null,
            checklist: software.checklist,
          }}
        />
      ) : (
        <p className="empty-note">Your Business OS questionnaire will appear here once your student workspace is ready.</p>
      )}
    </div>
  );
}
