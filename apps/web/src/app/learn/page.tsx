import { MemberDashboard } from "@/features/dashboard/member-dashboard";
import { ProductionMemberAccess } from "@/components/production-member-access";
import { isDemoMode } from "@/lib/config/mode";
import { getDashboard } from "@/lib/demo/repository";

export default function LearnDashboardPage() {
  if (!isDemoMode()) return <ProductionMemberAccess />;
  return <MemberDashboard dashboard={getDashboard("member-maria")} />;
}
