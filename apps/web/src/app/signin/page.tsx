import Link from "next/link";
import { redirect } from "next/navigation";
import type { Route } from "next";
import { isNeonAuthConfigured } from "@syntholo/auth/config";
import { neonGoogleAuthEnabled } from "@/lib/neon";
import { RESET_PASSWORD_PATH } from "@/lib/auth/member-destination";
import { getCurrentAccount } from "@/lib/server/accounts";
import { NeonAuthForm } from "./neon-auth-form";

export const dynamic = "force-dynamic";

function firstQueryValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function SetupNotice() {
  return (
    <div className="signin-page">
      <div className="signin-card">
        <Link className="brand" href="/"><span className="brand-mark">S</span> Syntholo</Link>
        <h1>Sign-in needs Neon Auth configuration</h1>
        <p>
          Student authentication runs on Neon Auth. Add the values below to your <code>.env</code>,
          then restart <code>npm run dev</code>.
        </p>
        <ol>
          <li>Enable Auth on your Neon project and copy the Auth URL into <code>NEON_AUTH_BASE_URL</code> and <code>NEXT_PUBLIC_NEON_AUTH_URL</code></li>
          <li>Set <code>NEON_AUTH_COOKIE_SECRET</code> to a 32+ character secret used only on the server</li>
          <li>Copy the Data API URL into <code>NEXT_PUBLIC_NEON_DATA_API_URL</code></li>
          <li>Optional: enable Google in the Neon Auth dashboard and set <code>NEXT_PUBLIC_NEON_AUTH_GOOGLE=true</code></li>
        </ol>
        <p><Link href="/learn">Preview the academy in demo mode</Link></p>
        <p><Link href="/">← Back to site</Link></p>
      </div>
    </div>
  );
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[]; error?: string | string[]; reset?: string | string[] }>;
}) {
  const params = await searchParams;
  const token = firstQueryValue(params.token);
  const resetError = firstQueryValue(params.error);
  if (token || resetError) {
    const next = new URLSearchParams();
    if (token) next.set("token", token);
    if (resetError) next.set("error", resetError);
    redirect(`${RESET_PASSWORD_PATH}?${next.toString()}` as Route);
  }

  const account = await getCurrentAccount();
  if (account) redirect("/learn");

  if (!isNeonAuthConfigured()) {
    return <SetupNotice />;
  }
  return (
    <NeonAuthForm
      googleEnabled={neonGoogleAuthEnabled()}
      passwordUpdated={firstQueryValue(params.reset) === "1"}
    />
  );
}
