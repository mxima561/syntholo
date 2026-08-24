"use client";

import { SignIn } from "@clerk/nextjs";
import Link from "next/link";

export function ClerkSignIn() {
  return (
    <div className="signin-page">
      <div className="signin-card">
        <Link className="brand" href="/"><span className="brand-mark">S</span> Syntholo</Link>
        <h1>Welcome back</h1>
        <p>Sign in with the work email you used at checkout to reach your academy workspace.</p>
        <SignIn routing="hash" />
      </div>
    </div>
  );
}
