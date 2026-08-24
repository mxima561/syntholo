import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentAccount, isClerkConfigured } from "@/lib/server/accounts";
import { ClerkSignIn } from "./clerk-sign-in";

export const dynamic = "force-dynamic";

function SetupNotice() {
  return (
    <div className="signin-page">
      <div className="signin-card">
        <Link className="brand" href="/"><span className="brand-mark">S</span> Syntholo</Link>
        <h1>Sign-in needs Clerk configuration</h1>
        <p>
          Student authentication runs on Clerk. Add the values below to your <code>.env</code>,
          then restart <code>npm run dev</code>.
        </p>
        <ol>
          <li>Create a US Clerk application at dashboard.clerk.com</li>
          <li>Copy the <strong>Publishable key</strong> into <code>NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY</code></li>
          <li>Copy the <strong>Secret key</strong> into <code>CLERK_SECRET_KEY</code></li>
          <li>Enable magic-link email and any approved social providers. Do not store student PII in Clerk metadata.</li>
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

  if (!isClerkConfigured()) {
    return <SetupNotice />;
  }
  return <ClerkSignIn />;
}
