import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminSectionPage from "./[section]/page";
import AdminContentPage from "./content/page";
import AdminOverviewPage from "./page";
import AdminProvisioningPage from "./provisioning/page";
import AdminLayout from "./layout";

const cookies = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() => vi.fn((location: string): never => {
  throw new Error(`NEXT_REDIRECT:${location}`);
}));

const staffActor = {
  kind: "staff",
  actorId: "10000000-0000-4000-8000-000000000001",
  workosUserId: "user_workos_1",
  staffId: "20000000-0000-4000-8000-000000000002",
  role: "admin",
  permissions: ["operations:read"],
  authenticatedAt: "2026-08-14T12:00:00.000Z",
} as const;

vi.mock("next/headers", () => ({ cookies }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...await importOriginal<typeof import("next/navigation")>(),
  redirect,
}));

const routes: readonly [string, () => ReactNode | Promise<ReactNode>][] = [
  ["/admin", () => AdminOverviewPage()],
  ["/admin layout", () => AdminLayout({ children: <p>Admin content</p> })],
  ["/admin/content", () => AdminContentPage()],
  ["/admin/provisioning", () => AdminProvisioningPage()],
  ["/admin/customers", () => AdminSectionPage({ params: Promise.resolve({ section: "customers" }) })],
];

describe("production admin routes", () => {
  beforeEach(() => {
    vi.stubEnv("APP_MODE", "production");
    vi.stubEnv("WEB_ORIGIN", "https://app.syntholo.test");
    vi.stubEnv("API_UPSTREAM_ORIGIN", "https://api.syntholo.test");
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_live_test");
    cookies.mockResolvedValue({ getAll: () => [] });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    cookies.mockReset();
    redirect.mockClear();
  });

  it.each(routes)("redirects %s before returning static admin content", async (_path, route) => {
    await expect(Promise.resolve().then(route)).rejects.toThrow(
      "NEXT_REDIRECT:/v1/staff/auth/sign-in?returnTo=%2Fadmin",
    );
  });

  it("renders a safe unavailable state when the staff API is down", async () => {
    cookies.mockResolvedValue({ getAll: () => [{ value: "x".repeat(43) }] });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));

    render(await AdminOverviewPage());

    expect(screen.getByRole("heading", { name: "Admin access unavailable" }))
      .toBeInTheDocument();
    expect(screen.queryByText(/Good morning, Alex|Northstar Advisory/u))
      .not.toBeInTheDocument();
  });

  it("renders a safe unavailable state for malformed staff identity data", async () => {
    cookies.mockResolvedValue({ getAll: () => [{ value: "x".repeat(43) }] });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ role: "admin" }),
      { status: 200 },
    )));

    render(await AdminOverviewPage());

    expect(screen.getByRole("heading", { name: "Admin access unavailable" }))
      .toBeInTheDocument();
    expect(screen.queryByText(/Good morning, Alex|Northstar Advisory/u))
      .not.toBeInTheDocument();
  });

  it("renders forbidden instead of redirecting a WorkOS coach", async () => {
    cookies.mockResolvedValue({ getAll: () => [{ value: "x".repeat(43) }] });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ ...staffActor, role: "coach" }),
      { status: 200 },
    )));

    render(await AdminOverviewPage());

    expect(screen.getByRole("heading", { name: "Admin access forbidden" }))
      .toBeInTheDocument();
    expect(screen.queryByText(/Good morning, Alex|Northstar Advisory/u))
      .not.toBeInTheDocument();
  });

  it("turns invalid production staff configuration into unavailable", async () => {
    vi.stubEnv("API_UPSTREAM_ORIGIN", "");

    render(await AdminOverviewPage());

    expect(screen.getByRole("heading", { name: "Admin access unavailable" }))
      .toBeInTheDocument();
  });
});
