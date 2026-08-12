type ProgressLike = { status: "not_started" | "in_progress" | "completed" };

export function getCourseProgressSummary(items: ProgressLike[]) {
  const completed = items.filter((item) => item.status === "completed").length;
  const active = items.filter((item) => item.status === "in_progress").length;
  const remaining = items.length - completed - active;

  return {
    completed,
    active,
    remaining,
    percent: items.length === 0 ? 0 : Math.round((completed / items.length) * 100),
  };
}
