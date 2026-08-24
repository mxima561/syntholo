import type { Metadata } from "next";
import type { ReactNode } from "react";
import { forbidden } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { AdminForbiddenError, requireStaff, staffDisplayName, staffInitials } from "@/lib/auth/staff";
import { inter, manrope } from "@/lib/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Syntholo Admin",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  let staff;
  try {
    staff = await requireStaff();
  } catch (error) {
    if (error instanceof AdminForbiddenError) forbidden();
    throw error;
  }

  return (
    <html className={`${inter.variable} ${manrope.variable}`} lang="en">
      <body>
        <AdminShell identity={{ initials: staffInitials(staff), name: staffDisplayName(staff) }}>
          {children}
        </AdminShell>
      </body>
    </html>
  );
}
