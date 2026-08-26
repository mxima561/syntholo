"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@syntholo/auth/client";

export function AdminNeonLogin() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(formData: FormData) {
    setError("");
    setPending(true);
    try {
      const { error: signInError } = await authClient.signIn.email({
        email: String(formData.get("email") ?? "").trim(),
        password: String(formData.get("password") ?? ""),
      });
      if (signInError) {
        setError(signInError.message ?? "Could not sign in.");
        return;
      }
      router.replace("/");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not sign in.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="signin-page">
      <div className="signin-card">
        <span className="brand"><span className="brand-mark">S</span> Syntholo Admin</span>
        <h1>Staff sign in</h1>
        <p>Cloudflare Access already verified that you can reach this origin. Sign in with Neon Auth so Syntholo can look up your <code>platform_admins</code> role. School admins should use the customer app instead of this console.</p>
        <form action={onSubmit} className="auth-form">
          <label>
            Work email
            <input autoComplete="email" name="email" required type="email" />
          </label>
          <label>
            Password
            <input autoComplete="current-password" minLength={8} name="password" required type="password" />
          </label>
          {error ? <p className="auth-error">{error}</p> : null}
          <button className="button button-primary" disabled={pending} type="submit">
            {pending ? "Signing in…" : "Continue"}
          </button>
        </form>
      </div>
    </div>
  );
}
