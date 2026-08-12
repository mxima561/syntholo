import { MemberDashboard } from "@/features/dashboard/member-dashboard";
import { getDashboard } from "@/lib/demo/repository";

export default function LearnDashboardPage() {
  return <MemberDashboard dashboard={getDashboard("member-maria")} />;
}
