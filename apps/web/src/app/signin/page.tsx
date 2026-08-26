import Link from "next/link";
import { redirect } from "next/navigation";
import { isNeonAuthConfigured } from "@syntholo/auth/config";
import { neonGoogleAuthEnabled } from "@/lib/neon";
import { getCurrentAccount } from "@/lib/server/accounts";
import { NeonAuthForm } from "./neon-auth-form";

export const dynamic = "force-dynamic";

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

export default async function SignInPage() {
  const account = await getCurrentAccount();
  if (account) redirect("/learn");

  if (!isNeonAuthConfigured()) {
    return <SetupNotice />;
  }
  return <NeonAuthForm googleEnabled={neonGoogleAuthEnabled()} />;
}
