import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
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
import SupportPage from "./support/page";
import TemplatesPage from "./templates/page";
import WorkflowsPage from "./workflows/page";
import LearnLayout from "./layout";
import * as demoRepository from "@/lib/demo/repository";

const useAuth = vi.hoisted(() => vi.fn());

vi.mock("@clerk/react", () => ({ useAuth }));
vi.mock("@/lib/demo/repository", async (importOriginal) => {
  const repository = await importOriginal<typeof import("@/lib/demo/repository")>();
  return {
    ...repository,
    getDashboard: vi.fn(repository.getDashboard),
  };
});

const routes: readonly [string, () => ReactNode | Promise<ReactNode>][] = [
  ["/learn", () => LearnDashboardPage()],
  ["/learn/business-os", () => BusinessOsPage()],
  ["/learn/community", () => CommunityPage()],
  ["/learn/course", () => CourseMapPage()],
  ["/learn/course/diagnose-1", () => LessonPage({ params: Promise.resolve({ lessonId: "diagnose-1" }) })],
  ["/learn/live", () => LivePage()],
  ["/learn/plan", () => PlanPage()],
  ["/learn/settings", () => SettingsPage()],
  ["/learn/settings/billing", () => SettingsSectionPage({ params: Promise.resolve({ section: "billing" }) })],
  ["/learn/support", () => SupportPage()],
  ["/learn/templates", () => TemplatesPage()],
  ["/learn/workflows", () => WorkflowsPage()],
];

describe("production member routes", () => {
  beforeEach(() => {
    vi.stubEnv("APP_MODE", "production");
    useAuth.mockReturnValue({
      getToken: vi.fn(),
      isLoaded: false,
      isSignedIn: undefined,
      sessionId: undefined,
    });
    vi.mocked(demoRepository.getDashboard).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    useAuth.mockReset();
  });

  it.each(routes)("contains %s behind the real member access gate", async (_path, route) => {
    render(await route());

    expect(screen.getByRole("status")).toHaveTextContent(
      _path === "/learn/course" ? "Loading your course" : "Checking your Academy access",
    );
    expect(screen.queryByText(/Maria Chen|Northstar Advisory/u)).not.toBeInTheDocument();
    if (_path === "/learn") {
      expect(demoRepository.getDashboard).not.toHaveBeenCalled();
    }
  });

  it("adds a production-safe member shell without demo identity", async () => {
    render(await LearnLayout({ children: <p>Production member state</p> }));

    expect(screen.getByText("Production member state")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Member navigation" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/learn");
    expect(screen.getByRole("link", { name: "Course" })).toHaveAttribute("href", "/learn/course");
    expect(screen.getByText("Signed-in member workspace")).toBeInTheDocument();
    expect(screen.queryByText(/Maria Chen|Northstar Advisory/u)).not.toBeInTheDocument();
  });

  it("preserves the local prototype only when demo mode is explicit", async () => {
    vi.stubEnv("APP_MODE", "demo");

    render(await LearnDashboardPage());

    expect(screen.getByText(/Northstar Advisory · Academy/u)).toBeInTheDocument();
    expect(demoRepository.getDashboard).toHaveBeenCalledWith("member-maria");
  });
});
