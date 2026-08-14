import type { ReactNode } from "react";
import { AdminAccessState } from "@/components/admin-access-state";
import { requireAdminAccess } from "@/lib/auth/staff-access";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const access = await requireAdminAccess();
  if (access !== "authorized") return <AdminAccessState state={access} />;
  const { AdminShell } = await import("@/components/admin-shell");
  return <AdminShell>{children}</AdminShell>;
}
