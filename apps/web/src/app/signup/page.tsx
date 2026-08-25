import { redirect } from "next/navigation";
import { isNeonAuthConfigured, neonGoogleAuthEnabled } from "@syntholo/auth/config";
import { getCurrentAccount } from "@/lib/server/accounts";
import { NeonAuthForm } from "../signin/neon-auth-form";

export const dynamic = "force-dynamic";

export default async function SignUpPage() {
  const account = await getCurrentAccount();
  if (account) redirect("/learn");
  if (!isNeonAuthConfigured()) redirect("/signin");
  return <NeonAuthForm googleEnabled={neonGoogleAuthEnabled()} initialMode="signup" />;
}
