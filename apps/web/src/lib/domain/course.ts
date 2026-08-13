import type { Course, Lesson } from "./types";

function lesson(
  id: string,
  stageId: string,
  number: number,
  title: string,
  summary: string,
  actionLabel: string,
  durationMinutes: number,
  resourceCount = 1,
): Lesson {
  return {
    id,
    stageId,
    number,
    title,
    summary,
    actionLabel,
    durationMinutes,
    resourceCount,
    required: true,
    transcript: [
      `This lesson helps your team apply ${title.toLowerCase()} to the way your business already works.`,
      "Start with the smallest version that creates a useful result. Name one owner, one trigger, and one measure before adding more technology.",
      "Use the action below to turn the lesson into a shared business decision.",
    ],
  };
}

export const academyCourse: Course = {
  id: "ai-operating-system-academy",
  title: "AI Operating System Academy",
  description: "Build safe rules, launch three workflows, and leave with a 90-day plan.",
  requiredLessonCount: 18,
  stages: [
    {
      id: "diagnose",
      number: 1,
      title: "Diagnose the business",
      shortTitle: "Diagnose",
      description: "Find the work worth changing before choosing tools.",
      releaseWeek: 1,
      lessons: [
        lesson("diagnose-1", "diagnose", 1, "What an AI operating system is", "See AI as a managed business capability, not a collection of prompts.", "Define what your operating system must improve", 8),
        lesson("diagnose-2", "diagnose", 2, "Map the customer and delivery journey", "Trace the work from first contact through recurring service.", "Map your customer journey", 11, 2),
        lesson("diagnose-3", "diagnose", 3, "Score opportunities by impact and effort", "Choose three useful workflows your team can realistically launch.", "Score your first five opportunities", 12, 2),
      ],
    },
    {
      id: "rules",
      number: 2,
      title: "Establish safe rules",
      shortTitle: "Rules",
      description: "Give the team simple boundaries they can follow.",
      releaseWeek: 1,
      lessons: [
        lesson("rules-1", "rules", 4, "Select approved AI tools", "Reduce tool sprawl and make ownership visible.", "Create your approved tool list", 9),
        lesson("rules-2", "rules", 5, "Define safe data-handling rules", "Decide what can and cannot enter an AI tool.", "Classify the data your team handles", 10, 2),
        lesson("rules-3", "rules", 6, "Write the team AI policy", "Turn safety decisions into a one-page team policy.", "Draft and share your AI policy", 12, 2),
      ],
    },
    {
      id: "growth",
      number: 3,
      title: "Build the growth engine",
      shortTitle: "Growth",
      description: "Respond faster and keep qualified leads moving.",
      releaseWeek: 2,
      lessons: [
        lesson("growth-1", "growth", 7, "Capture and organize leads", "Create one reliable entry point and source of truth.", "Choose your lead capture trigger", 10, 2),
        lesson("growth-2", "growth", 8, "Respond, qualify, and route leads", "Make the first response immediate without removing human judgment.", "Build your qualification rules", 12, 2),
        lesson("growth-3", "growth", 9, "Automate scheduling and follow-up", "Give every qualified opportunity a clear next step.", "Launch your follow-up sequence", 11, 3),
      ],
    },
    {
      id: "client",
      number: 4,
      title: "Build the client engine",
      shortTitle: "Client",
      description: "Create a consistent path from signed proposal to ongoing service.",
      releaseWeek: 3,
      lessons: [
        lesson("client-1", "client", 10, "Improve proposals and agreements", "Use AI to prepare work while preserving expert review.", "Map your proposal workflow", 9),
        lesson("client-2", "client", 11, "Automate client onboarding", "Deliver a confident, repeatable start for every client.", "Build your onboarding checklist", 12, 3),
        lesson("client-3", "client", 12, "Improve recurring communication", "Turn updates into a trusted rhythm instead of emergency work.", "Choose your client communication cadence", 8),
      ],
    },
    {
      id: "management",
      number: 5,
      title: "Build the management engine",
      shortTitle: "Management",
      description: "Help the team follow through and make better weekly decisions.",
      releaseWeek: 3,
      lessons: [
        lesson("management-1", "management", 13, "Create useful owner reporting", "Focus the dashboard on decisions, not decorative metrics.", "Choose your weekly owner measures", 10, 2),
        lesson("management-2", "management", 14, "Improve meetings and follow-up", "Prepare, capture, and assign actions consistently.", "Design your meeting follow-through", 9),
        lesson("management-3", "management", 15, "Organize reusable business knowledge", "Make approved answers easy for the team to find and maintain.", "Create your first knowledge source", 11, 2),
      ],
    },
    {
      id: "launch",
      number: 6,
      title: "Launch and improve",
      shortTitle: "Launch",
      description: "Test the system, train the team, and keep improving it.",
      releaseWeek: 4,
      lessons: [
        lesson("launch-1", "launch", 16, "Test workflows before launch", "Catch unsafe or confusing paths with a practical test plan.", "Run the launch test", 10, 2),
        lesson("launch-2", "launch", 17, "Train the team and assign ownership", "Make every live workflow understandable and owned.", "Complete your team enablement plan", 9, 2),
        lesson("launch-3", "launch", 18, "Measure results and plan 90 days", "Capture the baseline, target, next owner, and next review date.", "Finalize your 90-day roadmap", 12, 3),
      ],
    },
  ],
};

export const allLessons = academyCourse.stages.flatMap((stage) => stage.lessons);

