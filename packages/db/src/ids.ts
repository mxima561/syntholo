/** Short, copyable IDs derived from the row UUID. Stable for the life of the row. */
export function publicIdFromUuid(id: string, prefix: "STU" | "STF"): string {
  return `${prefix}-${id.replaceAll("-", "").slice(0, 8).toUpperCase()}`;
}
