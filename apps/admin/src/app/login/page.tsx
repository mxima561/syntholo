import { forbidden, redirect } from "next/navigation";
import { isNeonAuthConfigured } from "@syntholo/auth/config";
import { AdminForbiddenError, AdminUnauthenticatedError, requireStaff } from "@/lib/auth/staff";
import { AdminNeonLogin } from "./login-form";

export const dynamic = "force-dynamic";

export default async function AdminLoginPage() {
  if (isNeonAuthConfigured()) {
    try {
      await requireStaff();
      redirect("/");
    } catch (error) {
      if (error instanceof AdminForbiddenError) forbidden();
      if (!(error instanceof AdminUnauthenticatedError)) throw error;
    }
  }

  return <AdminNeonLogin />;
}
