import type { MemberKind, Working } from "@/lib/work";
import { durationText } from "@/lib/time";

/*
 * What the Workflow line draws (Direction D, docs: mock-workflow/frag-d.html): a Project's Steps
 * on one left-to-right line in Workflow order, and the Tasks at them as tokens. The shapes are
 * structural, so the canvas's `Workflow` (components/workflow/model.ts) passes as a `LineWorkflow`.
 * A Project has one or more named Workflows (ADR 0019); each Step belongs to one, and the
 * Project's order is its Workflows' order, then each Workflow's Steps'.
 */

/** The station every line ends on. A Connector with no `to` leads into it. */
export const DONE_STATION = "done";

/** A named Workflow of the Project: its place among them, 1 first. */
export type LineWorkflowName = { id: string; name: string; position: number };
/** A Step: its place in its Workflow (`workflow_id`), 1 first. */
export type LineStep = { id: string; workflow_id: string; name: string; position: number; skill?: { name: string } };
export type LineConnector = { id: string; from: string; to: string | null; name: string; position: number };
/**
 * A Project's Workflows, every Step of them and every Connector, one into another Workflow's Step
 * too; and the Workflow the line draws (`drawn`, by id): its Steps on the line, another Workflow's
 * only where a Connector crosses (an exit, an entry). Every Step when unsaid.
 */
export type LineWorkflow = { workflows: readonly LineWorkflowName[]; steps: readonly LineStep[]; connectors: readonly LineConnector[]; drawn?: string };

/**
 * The Skills of the Steps where Darkory files what a Parent needs once its Subtasks end: they sit
 * on the short branch "After a Parent", off the main line.
 */
export const branchSkills: readonly string[] = ["acceptance", "retro", "skill-review"];

/** The Skill of the Step where Darkory files a Breakdown Subtask: its Step sits on the branch "Break down", before the line. */
export const breakdownSkill = "breakdown";

/** The Organisation's builtin Skills, by name: no Step carrying one is where a Project's own work starts. */
export const builtinSkills: readonly string[] = [breakdownSkill, ...branchSkills];

/** What the Project's order reads of a Step: its Workflow and its place there. */
export type OrderedStep = { workflow_id: string; position: number };

/**
 * Compares two Steps in the Project's order: by their Workflow's position, then their own (the
 * order the server returns them in, and the one "the first Step" reads). A Step of no Workflow
 * listed comes last. Every list of a Project's Steps sorts with it.
 */
export function inProjectOrder(workflows: readonly Pick<LineWorkflowName, "id" | "position">[]): (a: OrderedStep, b: OrderedStep) => number {
  const rank = new Map(workflows.map((w) => [w.id, w.position]));
  const of = (s: OrderedStep) => rank.get(s.workflow_id) ?? Number.POSITIVE_INFINITY;
  return (a, b) => {
    const wa = of(a);
    const wb = of(b);
    // Two Steps of no listed Workflow tie on Infinity, whose difference is NaN.
    return (wa === wb ? 0 : wa - wb) || a.position - b.position;
  };
}

/** The Project's Steps in its order (`inProjectOrder`). */
function inPosition<S extends OrderedStep>(workflow: { workflows: readonly Pick<LineWorkflowName, "id" | "position">[]; steps: readonly S[] }): S[] {
  return [...workflow.steps].sort(inProjectOrder(workflow.workflows));
}

/** One Workflow's Steps in its order; none for a Workflow the Project does not have. */
export function stepsOf<S extends LineStep>(workflow: { workflows: readonly LineWorkflowName[]; steps: readonly S[] }, workflowId: string): S[] {
  return inPosition(workflow).filter((s) => s.workflow_id === workflowId);
}

/**
 * The Workflow a line of the Project draws when none is picked: the first by position when the
 * Project has several, else none, so a Project of one Workflow draws every Step as it always has.
 */
export function drawnWorkflow(workflow: { workflows: readonly LineWorkflowName[] }, picked?: string): string | undefined {
  if (picked && workflow.workflows.some((w) => w.id === picked)) return picked;
  if (workflow.workflows.length < 2) return undefined;
  return [...workflow.workflows].sort((a, b) => a.position - b.position)[0].id;
}

/**
 * Where a Task filed with no Step named starts: the first Step, in the Project's order, whose
 * Skill is the Project's own work (not breakdown, acceptance, retro or skill-review); else the
 * first Step with any Skill; else the first Step. The same rule as the server's `defaultStep`
 * (internal/core/workflow.go).
 */
export function startStep(workflow: LineWorkflow): string | undefined {
  const steps = inPosition(workflow);
  return (steps.find((s) => !!s.skill && !builtinSkills.includes(s.skill.name)) ?? steps.find((s) => !!s.skill) ?? steps[0])?.id;
}

/** Where each Step stands: on the main line, or off it on a branch or as a parking place. */
export type Sides = {
  /** Where new Tasks start (`startStep`); always on the main line. */
  start?: string;
  /** The breakdown Step (the first carrying breakdown, where Darkory files Breakdowns) on the branch "Break down", before the start Step. */
  before: Set<string>;
  /** The acceptance, retro and skill-review Steps on the branch "After a Parent". */
  after: Set<string>;
  /** The holds no Connector joins: parked off the line by the entry, moved on by hand. */
  holds: Set<string>;
};

/**
 * Which Steps leave the main line. A Step carrying a builtin Skill sits on a branch (breakdown
 * only the first such Step, the one Darkory files Breakdowns at) unless a
 * main-line Step leads into it (a Workflow that routes its work through Acceptance, Docs "pass" →
 * Acceptance, keeps it on the line, where its Tasks arrive along a Connector rather than being
 * filed there). A hold with no Connector in or out parks by the entry. The start Step never
 * leaves the line.
 */
export function sideSteps(workflow: LineWorkflow): Sides {
  const start = startStep(workflow);
  const steps = inPosition(workflow).filter((s) => s.id !== start);
  // Darkory files every Breakdown at the first Step carrying breakdown; any other is a Step like the rest.
  const first = inPosition(workflow).find((s) => s.skill?.name === breakdownSkill);
  const before = new Set(first && first.id !== start ? [first.id] : []);
  const after = new Set(steps.filter((s) => !!s.skill && branchSkills.includes(s.skill.name)).map((s) => s.id));
  const side = (id: string) => before.has(id) || after.has(id);
  for (let changed = true; changed; ) {
    changed = false;
    for (const c of workflow.connectors) {
      if (c.to !== null && side(c.to) && !side(c.from)) {
        before.delete(c.to);
        after.delete(c.to);
        changed = true;
      }
    }
  }
  const joined = new Set(workflow.connectors.flatMap((c) => (c.to === null ? [c.from] : [c.from, c.to])));
  const holds = new Set(steps.filter((s) => isHoldStep(s) && !joined.has(s.id)).map((s) => s.id));
  return { start, before, after, holds };
}

/** The Steps on the branch "After a Parent" (`sideSteps`'s `after`): what the editor's list groups by too. */
export function branchSteps(workflow: LineWorkflow): Set<string> {
  return sideSteps(workflow).after;
}

export function isHoldStep(step: LineStep): boolean {
  return !step.skill;
}

/** A Member as a token shows them: the mark, ringed by how they work there now. */
export type LineMember = { id: string; name: string; kind: MemberKind; working?: Working; paused?: boolean };

/** A Step with what the line says under its name: who takes its Tasks, and their median time there. */
export type LineStepFacts = LineStep & { takers?: readonly LineMember[]; medianMs?: number };
export type LineFacts = { workflows: readonly LineWorkflowName[]; steps: readonly LineStepFacts[]; connectors: readonly LineConnector[]; drawn?: string };

/** A Task named by its key: a blocker on a token's "by MAIN-10". */
export type LineBrief = { id: string; key: string; title: string };

/**
 * An open Task on the line: at its Step (`stepId`), or, for a question aimed at a Member, at no
 * Step (`aimedAt`). `since` is when it reached its Step, `heldSince` when its live Claim began.
 */
export type LineTask = {
  id: string;
  key: string;
  title: string;
  stepId?: string;
  parentId?: string;
  kind: "work" | "breakdown" | "acceptance" | "retrospective";
  since?: number;
  holder?: LineMember;
  heldSince?: number;
  aimedAt?: LineMember;
  /** The open Tasks blocking it, by key. */
  blockers: LineBrief[];
  /** A Parent's open Subtasks; absent on a Task with none. */
  openSubtasks?: number;
  /** Ended: drawn only as a green token at Done in a Parent's scope. */
  done?: boolean;
};

/** How a token reads: held (amber), held with its session waiting (dashed amber), waiting, blocked, in a hold, ended Done. */
export type TokenState = "held" | "idle" | "waiting" | "blocked" | "hold" | "done";

/** How a Task reads on the line, from its Claim, its Blocking and its Step. */
export function tokenState(task: LineTask, hold: boolean): TokenState {
  if (task.done) return "done";
  if (task.holder) return task.holder.working === "waiting" || task.holder.working === "stalled" ? "idle" : "held";
  if (task.blockers.length > 0) return "blocked";
  return hold ? "hold" : "waiting";
}

/** "now", "40s", "12m", "1h 2m", "18h", "3d": a token's time at its Step, as the drawing writes it. */
export function tokenTime(ms: number): string {
  return ms < 15_000 ? "now" : durationText(ms);
}

/** How long a pickup reads "now" on its token, with its tag beside it. */
export const PICKUP_MS = 60_000;

const stateWords: Record<TokenState, string> = {
  held: "held",
  idle: "held",
  waiting: "waiting",
  blocked: "blocked",
  hold: "in the hold",
  done: "Done",
};

/** What a screen reader hears of a token: "MAIN-10 Show reaction counts, held by builder (agent)". */
export function tokenLabel(t: LineTask, state: TokenState): string {
  const base = `${t.key} ${t.title}`;
  if (t.holder) return `${base}, held by ${t.holder.name}${t.holder.kind === "agent" ? " (agent)" : ""}`;
  if (state === "blocked") return `${base}, blocked by ${t.blockers.map((b) => b.key).join(" and ")}`;
  return `${base}, ${stateWords[state]}`;
}

/** "by MAIN-13", "by 2": who a blocked token waits on, at rest. */
export function blockedBy(t: LineTask): string | undefined {
  if (t.blockers.length === 0 || t.holder) return undefined;
  return t.blockers.length === 1 ? `by ${t.blockers[0].key}` : `by ${t.blockers.length}`;
}

