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
    cookies.mockReset();
    redirect.mockClear();
  });

  it.each(routes)("redirects %s before returning static admin content", async (_path, route) => {
    await expect(Promise.resolve().then(route)).rejects.toThrow(
      "NEXT_REDIRECT:/v1/staff/auth/sign-in?returnTo=%2Fadmin",
    );
  });
});
