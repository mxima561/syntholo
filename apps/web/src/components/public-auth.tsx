"use client";

import { ClerkProvider, SignIn, SignUp } from "@clerk/react";
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

export function PublicSignIn() {
  return (
    <SignIn
      fallbackRedirectUrl="/learn"
      path="/sign-in"
      routing="path"
      signUpUrl="/sign-up"
    />
  );
}

export function PublicSignUp() {
  return (
    <SignUp
      fallbackRedirectUrl="/learn"
      path="/sign-up"
      routing="path"
      signInUrl="/sign-in"
    />
  );
}
