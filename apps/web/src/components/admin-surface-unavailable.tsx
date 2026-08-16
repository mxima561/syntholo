import Link from "next/link";

/**
 * Honest placeholder for staff surfaces that have no production implementation
 * yet. These pages previously rendered invented customers, revenue, and SLA
 * state; an operator must never be shown fabricated data as if it were real.
 */
export function AdminSurfaceUnavailable({ title, description }: Readonly<{
  title: string;
  description: string;
}>) {
  return (
    <main className="state-page">
      <span className="brand-mark">S</span>
      <span className="micro-label">Staff console</span>
      <h1>{title}</h1>
      <p>{description}</p>
      <p>
        Certificate delivery is the only staff surface currently backed by
        production data.
      </p>
      <Link className="button button-dark button-medium" href="/admin/certificates">
        Open certificate delivery
      </Link>
    </main>
  );
}
