import type { Metadata } from "next";
import type { ReactNode } from "react";
import { forbidden, redirect } from "next/navigation";
import { headers } from "next/headers";
import { AdminShell } from "@/components/admin-shell";
import {
  AdminForbiddenError,
  AdminUnauthenticatedError,
  requireStaff,
  staffDisplayName,
  staffHasCapability,
  staffInitials,
} from "@/lib/auth/staff";
import { inter, manrope } from "@/lib/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Syntholo Admin",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const publicSurface = (await headers()).get("x-syntholo-admin-public") === "1";
  if (publicSurface) {
    return (
      <html className={`${inter.variable} ${manrope.variable}`} lang="en">
        <body>{children}</body>
      </html>
    );
  }

  let staff;
  try {
    staff = await requireStaff();
  } catch (error) {
    if (error instanceof AdminUnauthenticatedError) redirect("/login");
    if (error instanceof AdminForbiddenError) forbidden();
    throw error;
  }

  return (
    <html className={`${inter.variable} ${manrope.variable}`} lang="en">
      <body>
        <AdminShell
          identity={{ initials: staffInitials(staff), name: staffDisplayName(staff) }}
          capabilities={{
            billing: staffHasCapability(staff.role, "billing"),
            content: staffHasCapability(staff.role, "content"),
            support: staffHasCapability(staff.role, "support"),
            staffAdmin: staffHasCapability(staff.role, "staff"),
          }}
        >
          {children}
        </AdminShell>
      </body>
    </html>
  );
}
