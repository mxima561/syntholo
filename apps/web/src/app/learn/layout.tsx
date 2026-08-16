import type { ReactNode } from "react";
import { ProductionMemberShell } from "@/components/production-member-shell";

export default function LearnLayout({ children }: { children: ReactNode }) {
  return <ProductionMemberShell>{children}</ProductionMemberShell>;
}
