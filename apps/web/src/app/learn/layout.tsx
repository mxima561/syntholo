import type { ReactNode } from "react";
import { MemberShell } from "@/components/member-shell";

export default function LearnLayout({ children }: { children: ReactNode }) {
  return <MemberShell>{children}</MemberShell>;
}
