import type { LineConnector, LineStep, LineWorkflow } from "./model";

/*
 * Two Workflows the line is proved on: MAIN, the default Workflow at Sacca today
 * (mock-workflow/fixture.md), and BIG, the heavy 12-Step / 7-loop Workflow of the brief's F8.
 */

function workflow(steps: [id: string, name: string, skill: string | null][], connectors: [from: string, name: string, to: string | null][]): LineWorkflow {
  const s: LineStep[] = steps.map(([id, name, skill], i) => ({ id, name, position: i + 1, ...(skill ? { skill: { name: skill } } : {}) }));
  const count = new Map<string, number>();
  const c: LineConnector[] = connectors.map(([from, name, to]) => {
    const position = (count.get(from) ?? 0) + 1;
    count.set(from, position);
    return { id: `${from}:${name}`, from, to, name, position };
  });
  return { steps: s, connectors: c };
}

export const MAIN = workflow(
  [
    ["backlog", "Backlog", null],
    ["plan", "Plan", "breakdown"],
    ["build", "Build", "engineer"],
    ["qa", "QA", "qa"],
    ["review", "Review", "review"],
    ["acceptance", "Acceptance", "acceptance"],
    ["retro", "Retro", "retro"],
    ["skillreview", "Skill review", "skill-review"],
  ],
  [
    ["plan", "done", null],
    ["build", "pass", "qa"],
    ["build", "no UI change", "review"],
    ["qa", "pass", "review"],
    ["qa", "fail", "build"],
    ["review", "pass", null],
    ["review", "needs changes", "build"],
    ["review", "needs QA", "qa"],
    ["acceptance", "pass", null],
    ["acceptance", "fail", "build"],
    ["retro", "done", null],
    ["retro", "propose", "skillreview"],
    ["skillreview", "publish", null],
    ["skillreview", "needs changes", "retro"],
  ],
);

export const BIG = workflow(
  [
    ["backlog", "Backlog", null],
    ["triage", "Triage", "triage"],
    ["plan", "Plan", "breakdown"],
    ["design", "Design", "design"],
    ["build", "Build", "engineer"],
    ["creview", "Code review", "review"],
    ["qa", "QA", "qa"],
    ["sec", "Security review", "security"],
    ["docs", "Docs", "docs"],
    ["acc", "Acceptance", "acceptance"],
    ["release", "Release", "release"],
    ["retro", "Retro", "retro"],
  ],
  [
    ["backlog", "pass", "triage"],
    ["triage", "pass", "plan"],
    ["plan", "pass", "design"],
    ["plan", "no design needed", "build"],
    ["design", "pass", "build"],
    ["design", "rework", "plan"],
    ["build", "pass", "creview"],
    ["creview", "pass", "qa"],
    ["creview", "needs changes", "build"],
    ["qa", "pass", "sec"],
    ["qa", "fail", "build"],
    ["sec", "pass", "docs"],
    ["sec", "fail", "build"],
    ["docs", "pass", "acc"],
    ["docs", "needs changes", "build"],
    ["acc", "pass", "release"],
    ["acc", "fail", "build"],
    ["release", "pass", "retro"],
    ["release", "rollback", "qa"],
    ["retro", "pass", null],
  ],
);
