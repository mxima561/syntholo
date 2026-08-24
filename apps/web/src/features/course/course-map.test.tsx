import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CourseMap } from "./course-map";

const course = {
  title: "AI Operating System Academy",
  stages: [
    {
      id: "diagnose",
      number: 1,
      title: "Diagnose the business",
      shortTitle: "Diagnose",
      lessons: [
        { id: "diagnose-1", number: 1, title: "What an AI operating system is", durationMinutes: 8, summary: "This long summary should not appear on the map." },
        { id: "diagnose-2", number: 2, title: "Map the customer journey", durationMinutes: 11 },
      ],
    },
    {
      id: "rules",
      number: 2,
      title: "Establish safe rules",
      shortTitle: "Rules",
      lessons: [{ id: "rules-1", number: 3, title: "Select approved AI tools", durationMinutes: 9 }],
    },
  ],
};

describe("CourseMap", () => {
  it("renders a visual path without dumping lesson summaries", () => {
    render(<CourseMap activeLessonId="diagnose-2" completedLessonIds={["diagnose-1"]} course={course} />);

    expect(screen.getByRole("heading", { name: /ai operating system academy/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^continue$/i })).toHaveAttribute("href", "/learn/course/diagnose-2");
    expect(screen.getByRole("link", { name: /lesson 2: map the customer journey · current/i })).toHaveAttribute(
      "href",
      "/learn/course/diagnose-2",
    );
    expect(screen.queryByText(/this long summary should not appear/i)).not.toBeInTheDocument();
    expect(screen.getByText("Start")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /lesson \d/i })).toHaveLength(3);
  });
});
