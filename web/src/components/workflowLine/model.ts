import type { MemberKind, Working } from "@/lib/work";

/*
 * What the Workflow line draws (Direction D, docs: mock-workflow/frag-d.html): a Project's Steps
 * on one left-to-right line in Workflow order, and the Tasks at them as tokens. The shapes are
 * structural, so the canvas's `Workflow` (components/workflow/model.ts) passes as a `LineWorkflow`.
 */

/** The station every line ends on. A Connector with no `to` leads into it. */
export const DONE_STATION = "done";

export type LineStep = { id: string; name: string; position: number; skill?: { name: string } };
export type LineConnector = { id: string; from: string; to: string | null; name: string; position: number };
export type LineWorkflow = { steps: readonly LineStep[]; connectors: readonly LineConnector[] };

/**
 * The Skills of the Steps where Darkory files what a Parent needs once its Subtasks end: they sit
 * on the short branch "After a Parent", off the main line.
 */
export const branchSkills: readonly string[] = ["acceptance", "retro", "skill-review"];

/** The Skill of the Step where Darkory files a Breakdown Subtask: its Step sits on the branch "Break down", before the line. */
export const breakdownSkill = "breakdown";

/** The Organisation's builtin Skills, by name: no Step carrying one is where a Project's own work starts. */
export const builtinSkills: readonly string[] = [breakdownSkill, ...branchSkills];

const inPosition = (workflow: LineWorkflow) => [...workflow.steps].sort((a, b) => a.position - b.position);

/**
 * Where a Task filed with no Step named starts: the first Step whose Skill is the Project's own
 * work (not breakdown, acceptance, retro or skill-review); else the first Step with any Skill; else
 * the first Step. The same rule as the server's `defaultStep` (internal/core/workflow.go).
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
export type LineFacts = { steps: readonly LineStepFacts[]; connectors: readonly LineConnector[] };

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
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s < 15 ? "now" : `${s}s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 10) return min % 60 ? `${h}h ${min % 60}m` : `${h}h`;
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** "40s", "12m", "1h 2m": a span that has ended (a median, the time worked at a past Step), never "now". */
export function spanTime(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : tokenTime(ms);
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

