import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { allLessons } from "@/lib/domain/course";
import { LessonWorkspace } from "./lesson-workspace";

vi.mock("@/app/learn/actions", () => ({
  setLessonCompleteAction: vi.fn(async () => ({ ok: true })),
}));

describe("LessonWorkspace", () => {
  it("lets a member mark a practical lesson complete", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<LessonWorkspace lesson={allLessons[7]} onComplete={onComplete} />);

    await user.click(screen.getByRole("button", { name: /mark lesson complete/i }));

    expect(onComplete).toHaveBeenCalledWith("growth-2");
    expect(screen.getByText(/lesson completed/i)).toBeInTheDocument();
  });

  it("shows a transcript when the member asks for it", async () => {
    const user = userEvent.setup();
    render(<LessonWorkspace lesson={allLessons[7]} />);

    await user.click(screen.getByRole("button", { name: /transcript/i }));

    expect(screen.getByText(allLessons[7].transcript[0])).toBeInTheDocument();
  });
});
