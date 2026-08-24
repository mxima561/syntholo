import { AdminAccessState } from "@/components/admin-access-state";
import { ProductionContentAuthoring } from "@/components/production-content-authoring";
import { requireAdminAccess } from "@/lib/auth/staff-access";

export default async function AdminContentPage() {
  const access = await requireAdminAccess();
  if (access !== "authorized") return <AdminAccessState state={access} />;
  return <ProductionContentAuthoring />;
}
