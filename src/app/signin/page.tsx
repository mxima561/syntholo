import Link from "next/link";
import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import { isWorkosConfigured } from "@/lib/server/accounts";

export const dynamic = "force-dynamic";

function SetupNotice() {
  return (
    <div className="signin-page">
      <div className="signin-card">
        <Link className="brand" href="/"><span className="brand-mark">S</span> Syntholo</Link>
        <h1>Sign-in needs WorkOS configuration</h1>
        <p>
          Authentication runs on WorkOS AuthKit. Add the three values below to your <code>.env</code>,
          then restart <code>npm run dev</code>.
        </p>
        <ol>
          <li>Create a free project at dashboard.workos.com</li>
          <li>Copy the <strong>API secret key</strong> into <code>WORKOS_API_KEY</code></li>
          <li>Copy the <strong>Client ID</strong> into <code>WORKOS_CLIENT_ID</code></li>
          <li>Set <code>WORKOS_COOKIE_PASSWORD</code> to any long random string (32+ chars)</li>
          <li>In WorkOS → Redirects, add <code>{process.env.APP_URL ?? "http://localhost:3000"}/callback</code></li>
        </ol>
        <p><a href="/">← Back to site</a></p>
      </div>
    </div>
  );
}

export default async function SignInPage() {
  if (!isWorkosConfigured()) {
    return <SetupNotice />;
  }
  const signInUrl = await getSignInUrl();
  return (
    <div className="signin-page">
      <div className="signin-card">
        <Link className="brand" href="/"><span className="brand-mark">S</span> Syntholo</Link>
        <h1>Welcome back</h1>
        <p>Sign in with your work email to reach your academy workspace.</p>
        <a className="button button-primary button-large" href={signInUrl}>Continue to secure sign-in →</a>
      </div>
    </div>
  );
}
