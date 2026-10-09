import type { Task } from "@/api/client";
import { workflowsInOrder } from "@/components/workflowLine/model";
import { listedOn } from "@/screens/board/derive";
import type { WorkflowRecord } from "./bind";

/** A Workflow's row: its Steps, the Tasks waiting and being worked at them, and those done today. */
export type WorkflowRow = { id: string; name: string; steps: number; waiting: number; working: number; doneToday: number };

/**
 * The Project's Workflows in their order, each with what the live page reads of it: its Steps;
 * waiting, the open Tasks at its Steps no one is working (`tasks` − `working` of each Step);
 * working, those held (`working`); done today, the Tasks done since midnight listed in it
 * (`listedOn`, the server's `workflow_id`), as its line's "N today" counts them.
 */
export function workflowRows(graph: Pick<WorkflowRecord, "workflows" | "steps">, doneToday: readonly Pick<Task, "state" | "workflow_id">[]): WorkflowRow[] {
  return workflowsInOrder(graph.workflows).map((w) => {
    const steps = graph.steps.filter((s) => s.workflow_id === w.id);
    return {
      id: w.id,
      name: w.name,
      steps: steps.length,
      waiting: steps.reduce((n, s) => n + Math.max(0, s.tasks - s.working), 0),
      working: steps.reduce((n, s) => n + s.working, 0),
      doneToday: doneToday.filter((t) => listedOn(t, graph)?.has(w.id)).length,
    };
  });
}
