"use client";

import { useState } from "react";
import Link from "next/link";
import { authClient } from "@syntholo/auth/client";
import { Button } from "@/components/ui/button";
import { MEMBER_HOME_PATH, goToMemberHome, resetPasswordUrl } from "@/lib/auth/member-destination";

type Mode = "signin" | "signup" | "forgot";

function splitName(fullName: string) {
  const parts = fullName.trim().split(/\s+/);
  return { first: parts[0] ?? "", last: parts.slice(1).join(" ") };
}

export function NeonAuthForm({
  googleEnabled,
  initialMode = "signin",
  passwordUpdated = false,
}: {
  googleEnabled: boolean;
  initialMode?: Mode;
  passwordUpdated?: boolean;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(passwordUpdated ? "Password updated. Sign in with your new password." : "");
  const [pending, setPending] = useState(false);

  async function onSubmit(formData: FormData) {
    setError("");
    setNotice("");
    setPending(true);
    const email = String(formData.get("email") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    const name = String(formData.get("name") ?? "").trim();
    try {
      if (mode === "forgot") {
        const { error: resetError } = await authClient.requestPasswordReset({
          email,
          redirectTo: resetPasswordUrl(),
        });
        if (resetError) {
          setError(resetError.message ?? "Could not send a reset email.");
          return;
        }
        setNotice("If that email has an account, a reset link is on its way.");
        return;
      }
      if (mode === "signup") {
        const { first, last } = splitName(name || email);
        const { error: signUpError } = await authClient.signUp.email({
          email,
          password,
          name: `${first} ${last}`.trim() || email,
          callbackURL: MEMBER_HOME_PATH,
        });
        if (signUpError) {
          setError(signUpError.message ?? "Could not create that account.");
          return;
        }
        goToMemberHome();
        return;
      }
      const { error: signInError } = await authClient.signIn.email({
        email,
        password,
        callbackURL: MEMBER_HOME_PATH,
      });
      if (signInError) {
        setError(signInError.message ?? "Could not sign in with those details.");
        return;
      }
      goToMemberHome();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Authentication failed.");
    } finally {
      setPending(false);
    }
  }

  async function signInWithGoogle() {
    setError("");
    const { error: socialError } = await authClient.signIn.social({
      provider: "google",
      callbackURL: MEMBER_HOME_PATH,
    });
    if (socialError) setError(socialError.message ?? "Google sign-in is not available.");
  }

  return (
    <div className="signin-page">
      <div className="signin-card">
        <Link className="brand" href="/">
          <span className="brand-mark">S</span> Syntholo
        </Link>
        <h1>{mode === "signup" ? "Create your academy account" : mode === "forgot" ? "Reset your password" : "Welcome back"}</h1>
        <p>
          {mode === "signup"
            ? "Use the work email from checkout so your course and seats attach to this identity."
            : mode === "forgot"
              ? "We’ll email a reset link if that address already has a Syntholo account."
              : "Sign in with the work email you used at checkout to reach your academy workspace."}
        </p>
        <form action={onSubmit} className="auth-form">
          {mode === "signup" ? (
            <label>
              Full name
              <input autoComplete="name" name="name" required />
            </label>
          ) : null}
          <label>
            Work email
            <input autoComplete="email" name="email" required type="email" />
          </label>
          {mode !== "forgot" ? (
            <label>
              Password
              <input autoComplete={mode === "signup" ? "new-password" : "current-password"} minLength={8} name="password" required type="password" />
            </label>
          ) : null}
          {error ? <p className="auth-error">{error}</p> : null}
          {notice ? <p>{notice}</p> : null}
          <Button disabled={pending} size="large" type="submit">
            {pending ? "Please wait…" : mode === "signup" ? "Create account" : mode === "forgot" ? "Send reset link" : "Sign in"}
          </Button>
        </form>
        {googleEnabled && mode !== "forgot" ? (
          <Button onClick={signInWithGoogle} size="large" type="button" variant="secondary">
            Continue with Google
          </Button>
        ) : null}
        <div className="auth-alt">
          {mode === "signin" ? (
            <>
              <button className="signout-link" onClick={() => setMode("forgot")} type="button">Forgot password</button>
              <button className="signout-link" onClick={() => setMode("signup")} type="button">Create an account</button>
            </>
          ) : (
            <button className="signout-link" onClick={() => setMode("signin")} type="button">Back to sign in</button>
          )}
        </div>
        <p>
          <Link href="/">← Back to site</Link>
        </p>
      </div>
    </div>
  );
}
