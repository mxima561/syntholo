import type { ReactNode } from "react";
import { AdminShell } from "@/components/admin-shell";
import { requireAdminAccess } from "@/lib/auth/staff-access";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireAdminAccess();
  return <AdminShell>{children}</AdminShell>;
}
