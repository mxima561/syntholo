import { AdminAccessState } from "@/components/admin-access-state";
import { AdminSurfaceUnavailable } from "@/components/admin-surface-unavailable";
import { requireAdminAccess } from "@/lib/auth/staff-access";

export default async function AdminOverviewPage() {
  const access = await requireAdminAccess();
  if (access !== "authorized") return <AdminAccessState state={access} />;
  return (
    <AdminSurfaceUnavailable
      description="The operating brief is not built yet. It will report real customer, support, and revenue state once those modules are backed by the production API."
      title="Operations overview"
    />
  );
}
