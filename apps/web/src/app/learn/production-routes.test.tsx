import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BusinessOsPage from "./business-os/page";
import CommunityPage from "./community/page";
import LessonPage from "./course/[lessonId]/page";
import CourseMapPage from "./course/page";
import LearnDashboardPage from "./page";
import LivePage from "./live/page";
import PlanPage from "./plan/page";
import SettingsSectionPage from "./settings/[section]/page";
import SettingsPage from "./settings/page";
import CertificateSettingsPage from "./settings/certificates/page";
import SupportPage from "./support/page";
import TemplatesPage from "./templates/page";
import WorkflowsPage from "./workflows/page";
import LearnLayout from "./layout";

const useAuth = vi.hoisted(() => vi.fn());

vi.mock("@clerk/react", () => ({ useAuth }));

const routes: readonly [string, () => ReactNode | Promise<ReactNode>][] = [
  ["/learn", () => LearnDashboardPage()],
  ["/learn/business-os", () => BusinessOsPage()],
  ["/learn/community", () => CommunityPage()],
  ["/learn/course", () => CourseMapPage()],
  ["/learn/course/diagnose-1", () => LessonPage({ params: Promise.resolve({ lessonId: "diagnose-1" }) })],
  ["/learn/live", () => LivePage()],
  ["/learn/plan", () => PlanPage()],
  ["/learn/settings", () => SettingsPage()],
  ["/learn/settings/certificates", () => CertificateSettingsPage()],
  ["/learn/settings/billing", () => SettingsSectionPage({ params: Promise.resolve({ section: "billing" }) })],
  ["/learn/support", () => SupportPage()],
  ["/learn/templates", () => TemplatesPage()],
  ["/learn/workflows", () => WorkflowsPage()],
];

describe("production member routes", () => {
  beforeEach(() => {
    useAuth.mockReturnValue({
      getToken: vi.fn(),
      isLoaded: false,
      isSignedIn: undefined,
      sessionId: undefined,
    });
  });

  afterEach(() => {
    useAuth.mockReset();
  });

  it.each(routes)("contains %s behind the real member access gate", async (_path, route) => {
    render(await route());

    expect(screen.getByRole("status")).toHaveTextContent(
      _path === "/learn/course"
        ? "Loading your course"
        : _path === "/learn/plan" || _path === "/learn/workflows"
          ? "Loading your implementation workspace"
          : _path === "/learn/settings/certificates"
            ? "Loading certificate settings"
          : "Checking your Academy access",
    );
    expect(screen.queryByText(/Maria Chen|Northstar Advisory/u)).not.toBeInTheDocument();
  });

  it("hides member chrome until Clerk is loaded and signed in", async () => {
    render(await LearnLayout({ children: <p>Production member state</p> }));

    expect(screen.getByText("Production member state")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Member navigation" })).not.toBeInTheDocument();
    expect(screen.queryByText("Signed-in member workspace")).not.toBeInTheDocument();
  });

  it("adds a production-safe member shell without demo identity", async () => {
    useAuth.mockReturnValue({
      getToken: vi.fn(),
      isLoaded: true,
      isSignedIn: true,
      sessionId: "session_clerk_1",
    });
    render(await LearnLayout({ children: <p>Production member state</p> }));

    expect(screen.getByText("Production member state")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Member navigation" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/learn");
    expect(screen.getByRole("link", { name: "Course" })).toHaveAttribute("href", "/learn/course");
    expect(screen.getByRole("link", { name: "Plan" })).toHaveAttribute("href", "/learn/plan");
    expect(screen.getByRole("link", { name: "Workflows" })).toHaveAttribute("href", "/learn/workflows");
    expect(screen.getByRole("link", { name: "Certificates" })).toHaveAttribute("href", "/learn/settings/certificates");
    expect(screen.getByText("Signed-in member workspace")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Menu" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/Maria Chen|Northstar Advisory/u)).not.toBeInTheDocument();
  });

  it("keeps all five production mobile links in one 44px navigation row", async () => {
    const css = await readFile(resolve(process.cwd(), "src/styles/responsive.css"), "utf8");
    expect(css).toContain(".production-member-sidebar nav, .production-member-sidebar .nav-group:first-child { grid-template-columns: repeat(5, minmax(0, 1fr)); }");
    expect(css).toContain(".member-sidebar .nav-group a { min-height: 44px; }");
  });

  it("lets the member access heading wrap at narrow widths", async () => {
    const css = await readFile(resolve(process.cwd(), "src/styles/marketing.css"), "utf8");
    expect(css).toContain(".state-page h1 { max-width: 100%;");
    expect(css).toContain("overflow-wrap: anywhere");
  });
});
