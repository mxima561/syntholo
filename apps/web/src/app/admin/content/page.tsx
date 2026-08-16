import { AdminAccessState } from "@/components/admin-access-state";
import { AdminSurfaceUnavailable } from "@/components/admin-surface-unavailable";
import { requireAdminAccess } from "@/lib/auth/staff-access";

export default async function AdminContentPage() {
  const access = await requireAdminAccess();
  if (access !== "authorized") return <AdminAccessState state={access} />;
  return (
    <AdminSurfaceUnavailable
      description="The structured lesson editor is not built yet. Course, stage, lesson, block, and publication management will appear here once it is backed by the production content API."
      title="Course content"
    />
  );
}
