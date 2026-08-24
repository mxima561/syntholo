import Link from "next/link";

/**
 * The account-claim flow (PRD Flow 1, step 5) is not implemented yet. This page
 * previously simulated a completed purchase with a fabricated buyer email and a
 * button that granted access to demo data. It must not imply a real purchase or
 * a real workspace until the claim API exists.
 */
export default function ClaimPage() {
  return (
    <main className="state-page">
      <span className="brand-mark">S</span>
      <span className="micro-label">Account claim</span>
      <h1>Account claim is not available yet.</h1>
      <p>
        Syntholo is not selling the Academy yet, so there is no purchase to
        claim. When enrollment opens, your claim link is emailed to the address
        you use at checkout and is valid for seven days.
      </p>
      <Link className="button button-dark button-medium" href="/">
        View program options
      </Link>
    </main>
  );
}
