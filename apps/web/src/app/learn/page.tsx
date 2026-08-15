import { ProductionMemberDashboard } from "@/components/production-member-dashboard";
import { isDemoMode } from "@/lib/config/mode";

export default async function LearnDashboardPage() {
  if (!isDemoMode()) return <ProductionMemberDashboard />;
  const [{ MemberDashboard }, { getDashboard }] = await Promise.all([
    import("@/features/dashboard/member-dashboard"),
    import("@/lib/demo/repository"),
  ]);
  return <MemberDashboard dashboard={getDashboard("member-maria")} />;
}
