import { notFound } from "next/navigation";
import { AdminAccessState } from "@/components/admin-access-state";
import { AdminSurfaceUnavailable } from "@/components/admin-surface-unavailable";
import { requireAdminAccess } from "@/lib/auth/staff-access";

const sections = {
  customers: "Customers",
  support: "Support queue",
  community: "Community reports",
  commerce: "Commerce",
  analytics: "Analytics",
  settings: "Settings",
} as const;

export default async function AdminSectionPage({ params }: { params: Promise<{ section: string }> }) {
  const access = await requireAdminAccess();
  if (access !== "authorized") return <AdminAccessState state={access} />;
  const { section } = await params;
  const title = sections[section as keyof typeof sections];
  if (!title) notFound();
  return (
    <AdminSurfaceUnavailable
      description="This staff surface is not built yet. It will appear here once the module is backed by the production API."
      title={title}
    />
  );
}
