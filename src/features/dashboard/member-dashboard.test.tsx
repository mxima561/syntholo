import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getDashboard } from "@/lib/demo/repository";
import { MemberDashboard } from "./member-dashboard";

describe("MemberDashboard", () => {
  it("prioritizes one lesson, two recommendations, and the human right rail", () => {
    render(<MemberDashboard dashboard={getDashboard("member-maria")} />);

    expect(screen.getByRole("heading", { name: /keep building your business os/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /resume lesson/i })).toHaveAttribute("href", "/learn/course/growth-2");
    expect(screen.getAllByTestId("dashboard-recommendation")).toHaveLength(2);
    expect(screen.getByText(/naomi replied/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /browse lessons and templates/i })).toHaveAttribute("href", "/learn/course");
  });
});
