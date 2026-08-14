import type { ReactNode } from "react";
import { MemberShell } from "@/components/member-shell";
import { isDemoMode } from "@/lib/config/mode";

export default function LearnLayout({ children }: { children: ReactNode }) {
  return isDemoMode() ? <MemberShell>{children}</MemberShell> : children;
}
