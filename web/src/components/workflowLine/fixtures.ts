import type { LineConnector, LineStep, LineWorkflow } from "./model";
import saccaJSON from "./workflows/sacca.json";
import softwareJSON from "./workflows/software.json";
import { toCanvas } from "@/screens/workflow/bind";
import { workflowsFixture, workflowsSkills } from "@/test/fixtures";

/*
 * The Workflows the line is proved on: MAIN, the Workflow at Sacca today (mock-workflow/fixture.md;
 * seed-sample.sh's Project "Sample" draws the same one); SACCA, read from the Sacca Install's own
 * workflow.json; DEFAULT, the Workflow a new Project starts with (internal/core/workflow.go);
 * BIG, the heavy 12-Step / 7-loop Workflow of the brief's F8; and SOFTWARE, the software Workflow
 * (examples/workflows/software/workflow.json): 14 Steps, loops into Design and Build, skips.
 */

/** The one Workflow of a fixture written here. */
const WORK = { id: "work", name: "Work", position: 1 };

function workflow(steps: [id: string, name: string, skill: string | null][], connectors: [from: string, name: string, to: string | null][]): LineWorkflow {
  const s: LineStep[] = steps.map(([id, name, skill], i) => ({ id, workflow_id: WORK.id, name, position: i + 1, ...(skill ? { skill: { name: skill } } : {}) }));
  const count = new Map<string, number>();
  const c: LineConnector[] = connectors.map(([from, name, to]) => {
    const position = (count.get(from) ?? 0) + 1;
    count.set(from, position);
    return { id: `${from}:${name}`, from, to, name, position };
  });
  return { workflows: [WORK], steps: s, connectors: c };
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

/** A workflow.json as `darkory workflow set --file` reads it: Workflows, Steps and Connectors by name. */
type WorkflowFile = {
  workflows: { name: string; position: number }[];
  steps: { workflow: string; name: string; skill?: string; position: number }[];
  connectors: { from: string; to?: string; name: string; position: number }[];
};

const slug = (name: string) => name.toLowerCase().replace(/\W+/g, "-");

function fromFile(file: WorkflowFile): LineWorkflow {
  return {
    workflows: file.workflows.map((w) => ({ id: slug(w.name), name: w.name, position: w.position })),
    steps: file.steps.map((s) => ({ id: slug(s.name), workflow_id: slug(s.workflow), name: s.name, position: s.position, ...(s.skill ? { skill: { name: s.skill } } : {}) })),
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

/** The line's own width on the Workflow page at each window width (the sidebar and padding off), and in a Parent's card. */
export const PAGE = { 1024: 744, 1280: 1000, 1440: 1160, 1920: 1640 } as const;
export const PARENT = { 1024: 506, 1280: 762, 1440: 786, 1920: 786 } as const;

/** Every fixture by name, for the proofs that hold of them all. */
export const FIXTURES = { MAIN, SACCA, DEFAULT, BIG, SOFTWARE } as const;

/**
 * ADR 0019's five Workflows (`workflowsFixture`: Triage's four outcomes cross into Bugs, Features,
 * Prototypes and Support), as the line reads them, drawing the Workflow `drawn` (by `wfId`).
 */
export function FIVE(drawn?: string): LineWorkflow {
  const wf = toCanvas(workflowsFixture(), new Map(workflowsSkills.map((s) => [s.id, s])));
  return { ...wf, ...(drawn ? { drawn } : {}) };
}

/**
 * Two Workflows written here, a Workflow per entry of `workflows`, its Steps as `[id, name, skill]`;
 * Connectors as `[from, name, to]` by Step id, any of them crossing between the two.
 */
function several(workflows: [id: string, name: string, steps: [id: string, name: string, skill: string | null][]][], connectors: [from: string, name: string, to: string | null][], drawn?: string): LineWorkflow {
  const steps: LineStep[] = workflows.flatMap(([wf, , list]) => list.map(([id, name, skill], i) => ({ id, workflow_id: wf, name, position: i + 1, ...(skill ? { skill: { name: skill } } : {}) })));
  const count = new Map<string, number>();
  const c: LineConnector[] = connectors.map(([from, name, to]) => {
    const position = (count.get(from) ?? 0) + 1;
    count.set(from, position);
    return { id: `${from}:${name}`, from, to, name, position };
  });
  return { workflows: workflows.map(([id, name], i) => ({ id, name, position: i + 1 })), steps, connectors: c, ...(drawn ? { drawn } : {}) };
}

/**
 * A crossing between two branches: Work's Acceptance says accepted into Wrap's Retro. Both sit
 * after a Parent, so drawn alone Work's Acceptance carries an exit on its branch row, and Wrap's
 * Retro an entry on its own.
 */
export function WRAP(drawn: "work" | "wrap"): LineWorkflow {
  return several(
    [
      ["work", "Work", [["build", "Build", "engineer"], ["review", "Review", "review"], ["acceptance", "Acceptance", "acceptance"]]],
      ["wrap", "Wrap", [["retro", "Retro", "retro"], ["skillreview", "Skill review", "skill-review"]]],
    ],
    [
      ["build", "pass", "review"],
      ["review", "pass", null],
      ["acceptance", "accepted", "retro"],
      ["acceptance", "fail", "build"],
      ["retro", "done", null],
      ["retro", "propose", "skillreview"],
      ["skillreview", "publish", null],
    ],
    drawn,
  );
}

/**
 * Tasks reach Build from Support (along `outcome`, `bug` unless said) as well as being filed there. With `backlog`, Build is
 * not the line's first Step (a Backlog joined to it by `ready` stands before it), so both say so
 * over Build's head: where New Tasks start, and the entry from Support.
 */
export function MARKS(backlog: boolean, outcome = "bug"): LineWorkflow {
  return several(
    [
      ["work", "Work", [...(backlog ? [["backlog", "Backlog", null] as [string, string, null]] : []), ["build", "Build", "engineer"], ["qa", "QA", "qa"]]],
      ["support", "Support", [["support", "Support", "support"]]],
    ],
    [...(backlog ? [["backlog", "ready", "build"] as [string, string, string]] : []), ["build", "pass", "qa"], ["qa", "pass", null], ["support", outcome, "build"], ["support", "answered", null]],
    "work",
  );
}

/**
 * MAIN with an Ops Workflow QA escalates into twice: QA stands inside the arc needs changes runs
 * under, so its two exits' chips cannot hang on legs under it and go under everything instead.
 */
export function ESCALATE(): LineWorkflow {
  return {
    workflows: [...MAIN.workflows, { id: "ops", name: "Ops", position: 2 }],
    steps: [...MAIN.steps, { id: "hotfix", workflow_id: "ops", name: "Hotfix", position: 1, skill: { name: "ops" } }],
    connectors: [
      ...MAIN.connectors,
      { id: "qa:escalate", from: "qa", to: "hotfix", name: "escalate", position: 3 },
      { id: "qa:outage", from: "qa", to: "hotfix", name: "outage", position: 4 },
      { id: "hotfix:done", from: "hotfix", to: null, name: "done", position: 1 },
    ],
    drawn: "work",
  };
}

/**
 * BIG with an Ops Workflow QA sends Tasks into once ("esc → Ops › Fix", short enough to stand
 * clear between QA and Security review on a wide line). QA drops onto the return track into
 * Build (its fail), so the exit's leg down from QA would run along that drop: its chip goes under
 * everything instead.
 */
export function HOTFIX(): LineWorkflow {
  return {
    workflows: [...BIG.workflows, { id: "ops", name: "Ops", position: 2 }],
    steps: [...BIG.steps, { id: "fix", workflow_id: "ops", name: "Fix", position: 1, skill: { name: "ops" } }],
    connectors: [...BIG.connectors, { id: "qa:esc", from: "qa", to: "fix", name: "esc", position: 3 }, { id: "fix:done", from: "fix", to: null, name: "done", position: 1 }],
    drawn: "work",
  };
}
