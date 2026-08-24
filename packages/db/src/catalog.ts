export const DEFAULT_SOFTWARE_CHECKS = [
  "Test lead capture",
  "Qualification routing",
  "Booking path",
  "Email + SMS messages",
  "Client onboarding",
  "AI escalation",
  "Dashboard activity",
] as const;

export const DEFAULT_SOFTWARE_CHECKLIST = [
  { id: "brand", label: "Brand and business details", complete: false },
  { id: "pipeline", label: "Pipeline stages", complete: false },
  { id: "calendar", label: "Calendar and availability", complete: false },
  { id: "messaging", label: "Messaging registration", complete: false },
  { id: "assistant", label: "AI assistant scope", complete: false },
] as const;

export const ARTIFACT_STARTERS = [
  {
    kind: "readiness_map" as const,
    title: "Readiness & opportunity map",
    body: `Purpose
Map where AI can help this business without guessing.

Current operating rhythm


Top three bottlenecks


First workflow to build
- Problem:
- Trigger:
- Owner:
- Success measure:
`,
  },
  {
    kind: "ai_policy" as const,
    title: "Team AI policy",
    body: `Purpose
One approved source of truth for how the team uses AI.

Approved tools


Data that must never enter an AI system


Human review is required when


How we will revisit this policy
`,
  },
  {
    kind: "workflow_portfolio" as const,
    title: "Three-workflow launch portfolio",
    body: `Purpose
Track the three workflows that complete the Academy: Growth, Client, and Management.

Growth


Client


Management
`,
  },
  {
    kind: "enablement_checklist" as const,
    title: "Team enablement checklist",
    body: `Purpose
Make sure the team can run the workflows without the owner in the room.

Who needs to be trained


What they need access to


When we will review the first live week
`,
  },
  {
    kind: "roadmap" as const,
    title: "90-day roadmap",
    body: `Purpose
Lock the next 90 days after launch so the system keeps improving.

Days 1–30


Days 31–60


Days 61–90
`,
  },
] as const;

export const COURSE_TEMPLATES = [
  {
    id: "ai-opportunity-scorecard",
    title: "AI opportunity scorecard",
    description: "Score one workflow by impact, effort, data safety, and owner readiness.",
    filename: "ai-opportunity-scorecard.md",
    body: `# AI opportunity scorecard

Use this for one workflow at a time. Score each row 0–4.

| Criterion | Score (0–4) | Notes |
| --- | --- | --- |
| Impact if this works |  |  |
| Effort to ship a first version |  |  |
| Data safety (can we do this without confidential data?) |  |  |
| Owner clarity (named person, named review point) |  |  |
| Baseline we can measure today |  |  |

Recommended first workflow:

Why this one, not the others:
`,
  },
  {
    id: "team-ai-policy",
    title: "Team AI policy",
    description: "Approved tools, banned data, and where a human must review.",
    filename: "team-ai-policy.md",
    body: `# Team AI policy

Approved tools:

Data that never enters an AI system:

Human review is required when:

Incident contact:

Review date:
`,
  },
  {
    id: "workflow-design-canvas",
    title: "Workflow design canvas",
    description: "Problem, trigger, steps, human check, and the metric you will watch.",
    filename: "workflow-design-canvas.md",
    body: `# Workflow design canvas

Name:

Engine (growth / client / management):

Problem today:

Trigger:

Owner:

Steps:
1.
2.
3.
4.

Human review point:

Safety notes:

Baseline:

Target:
`,
  },
  {
    id: "launch-test-plan",
    title: "Launch test plan",
    description: "The smallest test that proves the workflow is safe to run live.",
    filename: "launch-test-plan.md",
    body: `# Launch test plan

Workflow:

What we will test:

Who will test it:

Pass condition:

Fail condition / rollback:

Date of test:
`,
  },
  {
    id: "90-day-roadmap",
    title: "90-day roadmap",
    description: "What the team will improve after the first three workflows are live.",
    filename: "90-day-roadmap.md",
    body: `# 90-day roadmap

Days 1–30:

Days 31–60:

Days 61–90:

Owner of this plan:

Next review date:
`,
  },
] as const;

function nextUtc(dayOfWeek: number, hour: number, weekOffset = 0): Date {
  const now = new Date();
  const result = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0));
  const delta = (dayOfWeek - result.getUTCDay() + 7) % 7;
  result.setUTCDate(result.getUTCDate() + (delta === 0 ? 7 : delta) + weekOffset * 7);
  return result;
}

export function upcomingOfficeHours(): Array<{
  title: string;
  description: string;
  region: string;
  hostName: string;
  startsAt: Date;
  endsAt: Date;
}> {
  const americasStart = nextUtc(4, 17);
  const europeStart = nextUtc(5, 8);
  return [
    {
      title: "Workflow office hours",
      description: "Bring one workflow map for direct, practical feedback.",
      region: "Americas",
      hostName: "Naomi Reed",
      startsAt: americasStart,
      endsAt: new Date(americasStart.getTime() + 60 * 60 * 1000),
    },
    {
      title: "Workflow office hours",
      description: "The repeated monthly session for Europe and Asia-friendly time zones.",
      region: "Europe / Asia",
      hostName: "Leon Park",
      startsAt: europeStart,
      endsAt: new Date(europeStart.getTime() + 60 * 60 * 1000),
    },
  ];
}
