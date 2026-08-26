"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { authClient } from "@syntholo/auth/client";
import { Button } from "@/components/ui/button";
import { SIGN_IN_PATH, goToMemberHome } from "@/lib/auth/member-destination";

function sessionHasUser(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const payload = "data" in result ? (result as { data?: unknown }).data : result;
  if (!payload || typeof payload !== "object") return false;
  const user = "user" in payload ? (payload as { user?: unknown }).user : null;
  return Boolean(user && typeof user === "object");
}

export function ResetPasswordForm({ token, errorCode }: { token: string; errorCode: string }) {
  const [error, setError] = useState(
    errorCode ? "That reset link is invalid or has expired. Request a new one." : "",
  );
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (token || errorCode) return;
    let cancelled = false;
    authClient
      .getSession()
      .then((result) => {
        if (!cancelled && sessionHasUser(result)) goToMemberHome();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [token, errorCode]);

  async function onSubmit(formData: FormData) {
    setError("");
    setPending(true);
    const password = String(formData.get("password") ?? "");
    const confirm = String(formData.get("confirm") ?? "");
    try {
      if (password !== confirm) {
        setError("Those passwords do not match.");
        return;
      }
      const { error: resetError } = await authClient.resetPassword({
        newPassword: password,
        token,
      });
      if (resetError) {
        setError(resetError.message ?? "Could not update that password.");
        return;
      }
      const session = await authClient.getSession().catch(() => null);
      if (sessionHasUser(session)) {
        goToMemberHome();
        return;
      }
      window.location.assign(`${SIGN_IN_PATH}?reset=1`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update that password.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="signin-page">
      <div className="signin-card">
        <Link className="brand" href="/">
          <span className="brand-mark">S</span> Syntholo
        </Link>
        <h1>{token ? "Choose a new password" : "Reset link needed"}</h1>
        <p>
          {token
            ? "Use the work email from your Neon Auth account. After this, sign in to reach your academy workspace."
            : "Open the latest reset email, or request a new link from sign in. This page does not send you to pricing."}
        </p>
        {token ? (
          <form action={onSubmit} className="auth-form">
            <label>
              New password
              <input autoComplete="new-password" minLength={8} name="password" required type="password" />
            </label>
            <label>
              Confirm password
              <input autoComplete="new-password" minLength={8} name="confirm" required type="password" />
            </label>
            {error ? <p className="auth-error">{error}</p> : null}
            <Button disabled={pending} size="large" type="submit">
              {pending ? "Please wait…" : "Update password"}
            </Button>
          </form>
        ) : (
          <>
            {error ? <p className="auth-error">{error}</p> : null}
            <Button href={SIGN_IN_PATH} size="large">
              Back to sign in
            </Button>
          </>
        )}
        <p>
          <Link href={SIGN_IN_PATH}>← Back to sign in</Link>
        </p>
      </div>
    </div>
  );
}
