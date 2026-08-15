import { AdminAccessState } from "@/components/admin-access-state";
import { ProductionCertificateDelivery } from "@/components/production-certificate-delivery";
import { requireAdminAccess } from "@/lib/auth/staff-access";

export default async function AdminCertificatesPage() {
  const access = await requireAdminAccess();
  if (access !== "authorized") return <AdminAccessState state={access} />;
  return <ProductionCertificateDelivery />;
}
