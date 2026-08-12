export type ScoreDimension = "strategy" | "safety" | "growth" | "client" | "operations";

export type ScorecardQuestion = {
  id: string;
  dimension: ScoreDimension;
  prompt: string;
  context: string;
};

export const scorecardQuestions: ScorecardQuestion[] = [
  { id: "strategy-1", dimension: "strategy", prompt: "How clear is your business plan for using AI?", context: "Think about agreed priorities, owners, and the result you expect—not a list of tools." },
  { id: "strategy-2", dimension: "strategy", prompt: "How consistently do leaders choose AI work based on business value?", context: "Strong teams compare impact, effort, risk, and readiness before building." },
  { id: "strategy-3", dimension: "strategy", prompt: "How clearly is ownership assigned for AI projects?", context: "A named owner should be responsible for performance and improvement." },
  { id: "strategy-4", dimension: "strategy", prompt: "How often do you measure whether an AI workflow creates value?", context: "Useful measures include time saved, faster response, fewer errors, and better conversion." },
  { id: "safety-1", dimension: "safety", prompt: "How clear are your rules for sensitive data in AI tools?", context: "Your team should know what is safe, restricted, and prohibited." },
  { id: "safety-2", dimension: "safety", prompt: "How carefully are AI tools reviewed before the team adopts them?", context: "Review privacy, access, data use, ownership, and how the tool is supported." },
  { id: "safety-3", dimension: "safety", prompt: "How consistently does a person review important AI output?", context: "Client advice, commitments, pricing, and sensitive communication need accountable human review." },
  { id: "safety-4", dimension: "safety", prompt: "How prepared is your team to handle an AI mistake?", context: "A practical process includes stopping the workflow, correcting the result, and learning from it." },
  { id: "growth-1", dimension: "growth", prompt: "How reliably do new leads enter one organized system?", context: "Include forms, calls, referrals, social messages, and manual introductions." },
  { id: "growth-2", dimension: "growth", prompt: "How quickly do qualified leads receive a useful first response?", context: "The response should be fast, relevant, and clear about the next step." },
  { id: "growth-3", dimension: "growth", prompt: "How consistently are leads qualified and routed?", context: "Useful routing considers service fit, timing, value, location, and who should respond." },
  { id: "growth-4", dimension: "growth", prompt: "How dependable is your follow-up when a lead goes quiet?", context: "A good sequence stays helpful and stops when a person replies or opts out." },
  { id: "client-1", dimension: "client", prompt: "How repeatable is your proposal process?", context: "Strong proposals use approved inputs and keep expert judgment in the final review." },
  { id: "client-2", dimension: "client", prompt: "How consistent is the experience after a client signs?", context: "Consider information gathering, access, scheduling, expectations, and internal handoff." },
  { id: "client-3", dimension: "client", prompt: "How proactively do clients receive useful updates?", context: "Consistent updates reduce uncertainty and last-minute status work." },
  { id: "client-4", dimension: "client", prompt: "How easy is it for your team to find approved client answers?", context: "Reusable knowledge should be current, owned, and simple to locate." },
  { id: "operations-1", dimension: "operations", prompt: "How much recurring administration is documented?", context: "Documented triggers, steps, owners, and exceptions make improvement possible." },
  { id: "operations-2", dimension: "operations", prompt: "How reliably do meetings turn into assigned actions?", context: "Preparation, decisions, owners, due dates, and follow-up should be visible." },
  { id: "operations-3", dimension: "operations", prompt: "How useful is the weekly information owners receive?", context: "A useful brief makes changes, exceptions, and decisions easy to see." },
  { id: "operations-4", dimension: "operations", prompt: "How confident is the team using your current AI tools?", context: "Confidence comes from practice, simple rules, working examples, and available help." },
];

export const scoreOptions = [
  { value: 0, label: "Not started" },
  { value: 1, label: "We have discussed it" },
  { value: 2, label: "Some practices exist" },
  { value: 3, label: "It is consistent in parts" },
  { value: 4, label: "We have a clear plan and use it consistently" },
] as const;

