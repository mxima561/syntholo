import { AdminAccessState } from "@/components/admin-access-state";
import { AdminSurfaceUnavailable } from "@/components/admin-surface-unavailable";
import { requireAdminAccess } from "@/lib/auth/staff-access";

export default async function AdminProvisioningPage() {
  const access = await requireAdminAccess();
  if (access !== "authorized") return <AdminAccessState state={access} />;
  return (
    <AdminSurfaceUnavailable
      description="The Business OS provisioning queue and its seven-check activation evidence are not built yet. Business OS checkout remains disabled until that operating process exists."
      title="Provisioning queue"
    />
  );
}
