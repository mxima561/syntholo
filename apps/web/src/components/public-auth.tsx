"use client";

import { ClerkProvider, SignIn, SignUp } from "@clerk/react";
import Link from "next/link";
import type { ReactNode } from "react";

export function PublicAuthProvider({
  children,
  publishableKey,
}: Readonly<{ children: ReactNode; publishableKey: string }>) {
  return (
    <ClerkProvider publishableKey={publishableKey}>
      {children}
    </ClerkProvider>
  );
}

function AuthFrame({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <main className="public-auth-page">
      <div className="public-auth-card">
        <Link aria-label="Syntholo home" className="brand" href="/">
          <span className="brand-mark">S</span>
          <span>Syntholo</span>
        </Link>
        {children}
        <Link className="public-auth-home" href="/">Back to the waitlist</Link>
      </div>
    </main>
  );
}

export function PublicSignIn() {
  return (
    <AuthFrame>
      <SignIn
        fallbackRedirectUrl="/learn"
        path="/sign-in"
        routing="path"
        signUpUrl="/sign-up"
      />
    </AuthFrame>
  );
}

export function PublicSignUp() {
  return (
    <AuthFrame>
      <SignUp
        fallbackRedirectUrl="/learn"
        path="/sign-up"
        routing="path"
        signInUrl="/sign-in"
      />
    </AuthFrame>
  );
}
