import type { Route } from "next";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemberDashboard } from "./member-dashboard";

describe("MemberDashboard", () => {
  it("prioritizes one lesson, two recommendations, and the human right rail", () => {
    render(
      <MemberDashboard
        coachThread={{ subject: "Workflow review", coachFirstName: "Naomi", lastMessage: "Your routing rules look solid." }}
        nextHref={"/learn/course/growth-2" as Route}
        nextLesson={{ id: "growth-2", title: "Design the growth workflow", summary: "Map trigger, owner, and review.", actionLabel: "Draft the workflow", stageTitle: "Growth engine" }}
        priorities={["Draft the workflow", "Team AI policy", "Growth workflow"]}
        progressPercent={39}
        publicId="STU-TESTID1"
        recommendations={[
          { label: "Coach feedback", title: "Team AI policy", description: "Review Naomi's two notes before your next team meeting.", href: "/learn/plan" as Route, actionLabel: "Open workspace", tone: "coral" },
          { label: "Workflow", title: "Client onboarding launch", description: "Complete the next test before launch.", href: "/learn/workflows" as Route, actionLabel: "Review workflow", tone: "gold" },
        ]}
        upcomingSession={{ title: "Workflow office hours", hostName: "Naomi Reed", region: "Americas" }}
        workspaceName="Northstar Advisory"
      />,
    );

    expect(screen.getByRole("heading", { name: /keep building your business os/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /resume lesson/i })).toHaveAttribute("href", "/learn/course/growth-2");
    const recommendations = screen.getAllByTestId("dashboard-recommendation");
    expect(recommendations).toHaveLength(2);
    expect(recommendations[0].querySelector(".dashboard-recommendation-illustration-coral[aria-hidden='true']")).toBeTruthy();
    expect(recommendations[1].querySelector(".dashboard-recommendation-illustration-gold[aria-hidden='true']")).toBeTruthy();
    expect(screen.getByText(/naomi said/i)).toBeInTheDocument();
    expect(screen.getByText(/your routing rules look solid/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view session/i })).toHaveClass("button-milestone");
    expect(screen.getByRole("link", { name: /view session/i })).toHaveAttribute("href", "/learn/live");
    expect(screen.getByRole("link", { name: /browse lessons and templates/i })).toHaveAttribute("href", "/learn/course");
  });
});
