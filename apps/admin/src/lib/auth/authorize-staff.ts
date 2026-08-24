import type { Staff } from "@syntholo/db";

export function authorizeStaffRow(staff: Staff | null): staff is Staff {
  return Boolean(staff && staff.status === "active");
}
