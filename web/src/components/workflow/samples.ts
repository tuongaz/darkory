import { tidy } from "./layout";
import type { Connector, Point, Step, Workflow } from "./model";
import type { GraphStep, GraphSubtask } from "./graph";

/**
 * Sample records for the design lab (/dev/design) and the tests: the plan's default Workflow
 * (Backlog · Plan · Build · Review · Retro · Skill review) with a QA and an Acceptance step, as
 * Sacca's is set (docs/build/model-v2-plan.md), its takers and live counts; and a Parent's
 * Subtasks over it.
 */

const planner = { id: "m-planner", name: "planner", kind: "agent" } as const;
const builder1 = { id: "m-builder-1", name: "builder-1", kind: "agent" } as const;
const builder2 = { id: "m-builder-2", name: "builder-2", kind: "agent" } as const;
const qa = { id: "m-qa", name: "qa-bot", kind: "agent" } as const;
const reviewer = { id: "m-reviewer", name: "reviewer", kind: "agent" } as const;
const retro = { id: "m-retro", name: "retro", kind: "agent" } as const;
const mai = { id: "m-mai", name: "Mai Tran", kind: "human" } as const;

const skill = (name: string) => ({ id: `k-${name}`, name });

/** The sample's one Workflow. */
const work = { id: "w-work", name: "Work", position: 1 };

const steps: Omit<Step, "x" | "y">[] = [
  { id: "s-backlog", workflow_id: work.id, name: "Backlog", position: 0, takers: [], tasks: 3, working: 0 },
  { id: "s-plan", workflow_id: work.id, name: "Plan", skill: skill("breakdown"), position: 1, takers: [{ ...planner, working: "running" }], tasks: 1, working: 1, medianMs: 25 * 60_000 },
  {
    id: "s-build",
    workflow_id: work.id,
    name: "Build",
    skill: skill("engineer"),
    position: 2,
    takers: [{ ...builder1, working: "running" }, { ...builder2, working: "stalled" }, mai],
    tasks: 4,
    working: 2,
    medianMs: 3 * 3_600_000,
  },
  { id: "s-qa", workflow_id: work.id, name: "QA", skill: skill("qa"), position: 3, takers: [{ ...qa, working: "waiting" }], tasks: 1, working: 1, medianMs: 50 * 60_000 },
  { id: "s-review", workflow_id: work.id, name: "Review", skill: skill("review"), position: 4, takers: [reviewer], tasks: 2, working: 0, medianMs: 70 * 60_000 },
  { id: "s-acceptance", workflow_id: work.id, name: "Acceptance", skill: skill("acceptance"), position: 5, takers: [{ ...mai, working: "held" }, qa], tasks: 1, working: 1 },
  { id: "s-retro", workflow_id: work.id, name: "Retro", skill: skill("retro"), position: 6, takers: [retro], tasks: 0, working: 0 },
  { id: "s-skill-review", workflow_id: work.id, name: "Skill review", skill: skill("skill-review"), position: 7, takers: [reviewer], tasks: 0, working: 0 },
];

const connector = (id: string, from: string, to: string | null, name: string, position: number): Connector => ({ id, from, to, name, position });

const connectors: Connector[] = [
  connector("c-plan-done", "s-plan", null, "done", 0),
  connector("c-build-qa", "s-build", "s-qa", "pass", 0),
  connector("c-qa-review", "s-qa", "s-review", "pass", 0),
  connector("c-qa-build", "s-qa", "s-build", "fail", 1),
  connector("c-review-done", "s-review", null, "pass", 0),
  connector("c-review-build", "s-review", "s-build", "needs changes", 1),
  connector("c-acceptance-done", "s-acceptance", null, "pass", 0),
  connector("c-acceptance-build", "s-acceptance", "s-build", "fail", 1),
  connector("c-retro-done", "s-retro", null, "done", 0),
  connector("c-retro-skill-review", "s-retro", "s-skill-review", "propose", 1),
  connector("c-skill-review-done", "s-skill-review", null, "publish", 0),
  connector("c-skill-review-retro", "s-skill-review", "s-retro", "needs changes", 1),
];

/** Laid out by Tidy up, as a Workflow the server stored after one. */
function laidOut(w: { steps: Omit<Step, "x" | "y">[]; connectors: Connector[] }): Workflow {
  const unplaced = { workflows: [work], steps: w.steps.map((s) => ({ ...s, x: 0, y: 0 })), connectors: w.connectors };
  const at = tidy(unplaced);
  return { workflows: [work], steps: unplaced.steps.map((s) => ({ ...s, ...at[s.id] })), connectors: w.connectors };
}

export const sampleWorkflow: Workflow = laidOut({ steps, connectors });

/**
 * The default Workflow a new Project starts with, at the places `darkory init` stores (decided
 * 2026-10-07): compact, in the board's order, one rank of 448 (a Step's 208 + 240 between) and rows
 * of 128. Backlog, Plan, Build and Retro down the first rank; Review beside Build, Skill review
 * beside Retro; Done is drawn at x 896. No Tasks yet; the roster's agents take it.
 */
export const defaultPlaces: Record<string, Point> = {
  "s-backlog": { x: 0, y: 0 },
  "s-plan": { x: 0, y: 128 },
  "s-build": { x: 0, y: 256 },
  "s-review": { x: 448, y: 256 },
  "s-retro": { x: 0, y: 384 },
  "s-skill-review": { x: 448, y: 384 },
};

export const defaultWorkflow: Workflow = (() => {
  const order = ["s-backlog", "s-plan", "s-build", "s-review", "s-retro", "s-skill-review"];
  const kept = new Set(["c-plan-done", "c-review-done", "c-review-build", "c-retro-done", "c-retro-skill-review", "c-skill-review-done", "c-skill-review-retro"]);
  return {
    workflows: [work],
    steps: order.map((id, i) => {
      const s = steps.find((x) => x.id === id)!;
      const takers = s.takers.filter((t) => t.kind === "agent").map(({ id, name, kind }) => ({ id, name, kind }));
      return { ...s, position: i, ...defaultPlaces[id], takers, tasks: 0, working: 0, medianMs: undefined };
    }),
    connectors: [...connectors.filter((c) => kept.has(c.id)), connector("c-build-review", "s-build", "s-review", "pass", 0)],
  };
})();

export const sampleSteps: GraphStep[] = [...sampleWorkflow.steps]
  .sort((a, b) => a.position - b.position)
  .map(({ id, name, skill }) => ({ id, name, skill }));

const sub = (n: number, title: string, rest: Partial<GraphSubtask> & Pick<GraphSubtask, "stepId" | "state">): GraphSubtask => ({
  id: `t-${n}`,
  key: `MAIN-${n}`,
  title,
  blockedBy: [],
  kind: "work",
  ...rest,
});

/** A Parent, MAIN-2 "Support emoji in names", part way through: eight Subtasks, five Blockings. */
export const sampleSubtasks: GraphSubtask[] = [
  sub(3, "Break down: Support emoji in names", { stepId: null, state: "done", kind: "breakdown" }),
  sub(4, "Store names as UTF-8 throughout", { stepId: null, state: "done" }),
  sub(5, "Normalise names on input", { stepId: "s-review", state: "open", blockedBy: [] }),
  sub(6, "Render emoji in the sidebar", { stepId: "s-build", state: "open", holder: builder1, working: "running", blockedBy: [] }),
  sub(7, "Search matches emoji names", { stepId: "s-build", state: "open", blockedBy: ["t-5"] }),
  sub(8, "Emoji in branch names", { stepId: "s-build", state: "open", blockedBy: ["t-7", "t-10"] }),
  sub(9, "Test names in every script", { stepId: "s-qa", state: "open", holder: qa, working: "waiting", blockedBy: [] }),
  sub(10, "Which emoji may a key hold?", { stepId: null, state: "open", aimedAt: mai, blockedBy: [] }),
  sub(11, "Old avatars keep their initials", { stepId: "s-build", state: "open", blockedBy: ["t-6", "t-9"] }),
  sub(12, "Drop the ASCII fallback", { stepId: null, state: "dropped" }),
];
