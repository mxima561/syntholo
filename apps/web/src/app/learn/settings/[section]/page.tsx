import { notFound } from "next/navigation";
import { ProductionMemberAccess } from "@/components/production-member-access";

export default async function SettingsSectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (section !== "billing") notFound();
  return <ProductionMemberAccess />;
}
