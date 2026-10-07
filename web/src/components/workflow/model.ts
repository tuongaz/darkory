import type { MemberKind, Working } from "@/lib/work";

/**
 * A Project's Workflow as the canvas draws it (model v2, ADR 0016): its Steps and the Connectors
 * between them, with the live facts `GET /v1/projects/{project}/workflow` adds per step. M4 binds
 * the record to these shapes; the canvas reads nothing else.
 */
export type Workflow = { steps: Step[]; connectors: Connector[] };

/** A Member of the Project holding a step's Skill. `working` rings their mark (MemberAvatar). */
export type Taker = { id: string; name: string; kind: MemberKind; working?: Working };

export type Step = {
  id: string;
  name: string;
  /** The Skill a Member needs to take the Tasks at it; absent on a hold. */
  skill?: { id: string; name: string };
  /** Its place in the Workflow's order: the board's columns, the list's groups. */
  position: number;
  /** Where the canvas draws it: the node's top-left corner, in canvas pixels. */
  x: number;
  y: number;
  takers: Taker[];
  /** Open Tasks at it, and how many of them a live Claim holds. */
  tasks: number;
  working: number;
  /** The median time a Task spent at it over the last 30 days. */
  medianMs?: number;
};

/** A named way out of a step, into another step or into Done (`to: null`). */
export type Connector = { id: string; from: string; to: string | null; name: string; position: number };

export type Point = { x: number; y: number };

/** The ends of a Connector a drag proposes: `to` null is Done, `"dropped"` the Dropped node. */
export type Ends = { from: string; to: string | null | "dropped" };

/** A step without a Skill: no one is offered its Tasks, and a human moves them on. */
export function isHold(step: Step): boolean {
  return !step.skill;
}

/** A step carrying a Skill nobody in the Project holds: its Tasks wait for no one. */
export function unstaffed(step: Step): boolean {
  return !!step.skill && step.takers.length === 0;
}

/** The open Tasks at a step that nobody holds. */
export function waitingAt(step: Step): number {
  return Math.max(0, step.tasks - step.working);
}

export function stepsInOrder(workflow: Workflow): Step[] {
  return [...workflow.steps].sort((a, b) => a.position - b.position);
}

/** The Connectors out of a step, in their order: the outcomes its holder may name. */
export function outgoing(workflow: Workflow, stepId: string): Connector[] {
  return workflow.connectors.filter((c) => c.from === stepId).sort((a, b) => a.position - b.position);
}

/** Where a Connector leads, in words: a step's name, or Done. */
export function targetName(workflow: Workflow, to: string | null): string {
  return to === null ? "Done" : (workflow.steps.find((s) => s.id === to)?.name ?? "a step that is gone");
}

/**
 * Why a Connector with these ends cannot be, in words, before anything is sent; undefined when
 * it can. `/v1` refuses a Connector naming a missing step; the glossary has a Connector lead
 * into another step or Done, and Dropped needs none.
 */
export function connectProblem(workflow: Workflow, { from, to }: Ends): string | undefined {
  const source = workflow.steps.find((s) => s.id === from);
  if (!source) return "A Connector leads out of a step.";
  if (to === "dropped") return "Dropped needs no Connector: a Task's Owner drops it from any step.";
  if (to === from) return `A Connector leads out of ${source.name} into another step or Done.`;
  if (to !== null && !workflow.steps.some((s) => s.id === to)) return "That step is gone.";
  return undefined;
}

/**
 * Why a step cannot be deleted as asked, in words: its Tasks need a step to go to (`/v1` would
 * refuse `step_in_use`), and that step must be another of this Workflow's.
 */
export function deleteProblem(workflow: Workflow, step: Step, moveTo?: string): string | undefined {
  if (step.tasks === 0) return undefined;
  if (!moveTo) return `${countTasks(step.tasks)} ${step.tasks === 1 ? "is" : "are"} at ${step.name}: say which step they move to.`;
  if (moveTo === step.id || !workflow.steps.some((s) => s.id === moveTo)) return "Pick another step of this Workflow.";
  return undefined;
}

export function countTasks(n: number): string {
  return `${n} ${n === 1 ? "Task" : "Tasks"}`;
}

/** A duration as a step's median says it: "40 min", "3 h", "2 d". */
export function durationText(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${Math.max(1, min)} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}
