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
  return <SignIn />;
}

export function PublicSignUp() {
  return <SignUp />;
}
