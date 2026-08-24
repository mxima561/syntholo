import { AdminAccessState } from "@/components/admin-access-state";
import { ProductionCustomers } from "@/components/production-customers";
import { requireAdminAccess } from "@/lib/auth/staff-access";

export default async function AdminCustomersPage() {
  const access = await requireAdminAccess();
  if (access !== "authorized") return <AdminAccessState state={access} />;
  return <ProductionCustomers />;
}
