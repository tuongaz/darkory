import type { Task } from "@/api/client";

/** A Workflow of the Project, as the Subtask line reads it. */
type Named = { id: string; name: string };

/** What a Parent's Subtask line draws of a Project of several Workflows, and what it leaves to theirs. */
export type SubtaskLine = {
  /** The Workflow the line draws; none for a Project of one, or with no open Subtask at a Step (the line's own default). */
  workflow?: string;
  /** The open Subtasks at Steps of each other Workflow, in the Project's order: "2 in Bugs" in the header. */
  elsewhere: { id: string; name: string; n: number }[];
};

/**
 * Which Workflow a Parent's Subtask line draws: the one its open Subtasks share; when they are
 * spread over several, that of the first of them in the Project's order; with none at a Step, the
 * line's own default. The open Subtasks at another Workflow's Steps are counted by Workflow, so the
 * header says where they are rather than letting them vanish. `steps` are the Project's in its
 * order (Workflow, then Step).
 */
export function subtaskLine(subtasks: readonly Pick<Task, "state" | "step_id">[], steps: readonly { id: string; workflow_id: string }[], workflows: readonly Named[]): SubtaskLine {
  if (workflows.length < 2) return { elsewhere: [] };
  const index = new Map(steps.map((s, i) => [s.id, i]));
  const at = subtasks
    .filter((s) => s.state === "open" && !!s.step_id && index.has(s.step_id))
    .map((s) => steps[index.get(s.step_id!)!])
    .sort((a, b) => index.get(a.id)! - index.get(b.id)!);
  const workflow = at[0]?.workflow_id;
  if (!workflow) return { elsewhere: [] };
  const counts = new Map<string, number>();
  for (const s of at) if (s.workflow_id !== workflow) counts.set(s.workflow_id, (counts.get(s.workflow_id) ?? 0) + 1);
  const elsewhere = workflows.filter((w) => counts.has(w.id)).map((w) => ({ id: w.id, name: w.name, n: counts.get(w.id)! }));
  return { workflow, elsewhere };
}
