import Link from "next/link";
import { redirect } from "next/navigation";
import { acceptInvitation, getInvitationPreview } from "@syntholo/db";
import { getCurrentAccount, requireStudentAccount } from "@/lib/server/accounts";
import { Button } from "@/components/ui/button";
import type { Route } from "next";

export const dynamic = "force-dynamic";

async function acceptInviteAction(formData: FormData) {
  "use server";
  const token = String(formData.get("token") ?? "").trim();
  const account = await requireStudentAccount();
  await acceptInvitation(token, account.id);
  redirect("/learn");
}

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const preview = await getInvitationPreview(token);
  const account = await getCurrentAccount();

  if (!preview) {
    return (
      <main className="claim-page">
        <section className="claim-card">
          <span className="micro-label">Invitation</span>
          <h1>This invite is not valid.</h1>
          <p>Ask the account owner to send a new link from Settings.</p>
          <Button href={"/" as Route}>Back to Syntholo</Button>
        </section>
      </main>
    );
  }

  const expired = preview.status !== "pending" || preview.expiresAt <= new Date();
  if (expired) {
    return (
      <main className="claim-page">
        <section className="claim-card">
          <span className="micro-label">Invitation</span>
          <h1>This invite has expired.</h1>
          <p>Ask the owner of {preview.accountName} to send a new seat.</p>
          <Button href={"/" as Route}>Back to Syntholo</Button>
        </section>
      </main>
    );
  }

  return (
    <main className="claim-page">
      <section className="claim-card">
        <span className="micro-label">Academy seat</span>
        <h1>Join {preview.accountName}</h1>
        <p>This seat is reserved for {preview.email}. Sign in with that work email, then accept.</p>
        {account ? (
          <form action={acceptInviteAction}>
            <input type="hidden" name="token" value={token} />
            <Button type="submit">Accept seat as {account.email}</Button>
          </form>
        ) : (
          <p>
            <Link href={"/signin" as Route}>Sign in to accept this seat</Link>
          </p>
        )}
      </section>
    </main>
  );
}
