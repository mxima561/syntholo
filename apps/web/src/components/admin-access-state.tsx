import Link from "next/link";

export function AdminAccessState({ state }: Readonly<{
  state: "forbidden" | "unavailable";
}>) {
  const forbidden = state === "forbidden";
  return (
    <main className="state-page" role="alert">
      <span className="brand-mark">S</span>
      <span className="micro-label">Staff access</span>
      <h1>{forbidden ? "Admin access forbidden" : "Admin access unavailable"}</h1>
      <p>
        {forbidden
          ? "Your staff account is authenticated but is not authorized for administration."
          : "We could not safely verify staff access. Please try again later."}
      </p>
      <Link className="button button-dark button-medium" href="/">
        Return to Syntholo
      </Link>
    </main>
  );
}
