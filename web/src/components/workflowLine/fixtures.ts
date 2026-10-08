import type { LineConnector, LineStep, LineWorkflow } from "./model";
import saccaJSON from "./workflows/sacca.json";
import softwareJSON from "./workflows/software.json";

/*
 * The Workflows the line is proved on: MAIN, the Workflow at Sacca today (mock-workflow/fixture.md;
 * seed-sample.sh's Project "Sample" draws the same one); SACCA, read from the Sacca Install's own
 * workflow.json; DEFAULT, the Workflow a new Project starts with (internal/core/workflow.go);
 * BIG, the heavy 12-Step / 7-loop Workflow of the brief's F8; and SOFTWARE, the software Workflow
 * (examples/workflows/software/workflow.json): 14 Steps, loops into Design and Build, skips.
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

/** A workflow.json as `darkory workflow set --file` reads it: Steps and Connectors by name. */
type WorkflowFile = {
  steps: { name: string; skill?: string; position: number }[];
  connectors: { from: string; to?: string; name: string; position: number }[];
};

const slug = (name: string) => name.toLowerCase().replace(/\W+/g, "-");

function fromFile(file: WorkflowFile): LineWorkflow {
  return {
    steps: file.steps.map((s) => ({ id: slug(s.name), name: s.name, position: s.position, ...(s.skill ? { skill: { name: s.skill } } : {}) })),
    connectors: file.connectors.map((c) => ({ id: `${slug(c.from)}:${c.name}`, from: slug(c.from), to: c.to ? slug(c.to) : null, name: c.name, position: c.position })),
  };
}

export const SACCA = fromFile(saccaJSON);
export const SOFTWARE = fromFile(softwareJSON);

export const DEFAULT = workflow(
  [
    ["backlog", "Backlog", null],
    ["plan", "Plan", "breakdown"],
    ["build", "Build", "engineer"],
    ["review", "Review", "review"],
    ["retro", "Retro", "retro"],
    ["skillreview", "Skill review", "skill-review"],
  ],
  [
    ["plan", "done", null],
    ["build", "pass", "review"],
    ["review", "pass", null],
    ["review", "needs changes", "build"],
    ["retro", "done", null],
    ["retro", "propose", "skillreview"],
    ["skillreview", "publish", null],
    ["skillreview", "needs changes", "retro"],
  ],
);

/** Every fixture by name, for the proofs that hold of them all. */
export const FIXTURES = { MAIN, SACCA, DEFAULT, BIG, SOFTWARE } as const;
