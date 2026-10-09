// Which of a Project's Workflows a page shows (ADR 0019, decision 8): `?workflow=`, else the one
// this browser last picked in the Project, else the first. WorkflowChip picks it.
import { useCallback } from "react";
import { useSearchParams } from "react-router";
import type { Project, Task, Workflow } from "@/api/client";
import { workflowsInOrder } from "@/components/workflowLine/model";
import { toShort } from "@/lib/shortid";

/** The search parameter naming the Workflow a page shows of a Project of several. */
export const workflowParam = "workflow";

/** Where this browser remembers the Workflow last picked in a Project. */
export const workflowKey = (projectKey: string) => `darkory.workflow.${projectKey}`;

/** The Workflow this browser last picked in the Project, if any; it may since have been deleted. */
export function remembered(projectKey: string): string | undefined {
  try {
    return localStorage.getItem(workflowKey(projectKey)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Remembers the Workflow picked in the Project, in this browser. */
export function remember(projectKey: string, id: string) {
  try {
    localStorage.setItem(workflowKey(projectKey), id);
  } catch {
    // Storage refused (a private window): the address still says the Workflow.
  }
}

/**
 * The Workflow a page of the Project shows: the one `?workflow=` names (an old link's long id read
 * as the short one), else the one this browser last picked in the Project, else the first by
 * position. A name that is no Workflow of the Project (one since deleted) is passed over. `set`
 * picks one: the address says it and the browser remembers it; picking the one shown replaces
 * the address rather than adding to the history. No id until the Workflows load.
 */
/**
 * How a pick is made: `remember` false leaves the browser's memory as it is (a Workflow not saved
 * yet); `also` changes the address in the same step (the editor's picked Step, cleared); `replace`
 * says it in place of the address, with no new step in the history (the editor's picks).
 */
export type PickOptions = { remember?: boolean; also?: (params: URLSearchParams) => void; replace?: boolean };

export function usePickedWorkflow(
  project: Pick<Project, "key">,
  workflows: readonly Pick<Workflow, "id" | "position">[] | undefined,
): { id: string | undefined; set: (id: string, options?: PickOptions) => void } {
  const [params, setParams] = useSearchParams();
  const named = params.get(workflowParam);
  const known = (id: string | undefined | null) => (id && workflows?.some((w) => w.id === id) ? id : undefined);
  const first = workflows && workflowsInOrder(workflows)[0]?.id;
  const id = known(named && toShort(named)) ?? known(remembered(project.key)) ?? first;
  const set = useCallback(
    (next: string, options: PickOptions = {}) => {
      if (options.remember !== false) remember(project.key, next);
      // Picking the one shown only says it in the address, in place: Back still leaves the page.
      setParams(
        (p) => {
          const out = new URLSearchParams(p);
          out.set(workflowParam, next);
          options.also?.(out);
          return out;
        },
        { replace: options.replace || next === id },
      );
    },
    [project.key, setParams, id],
  );
  return { id, set };
}

/** The Workflow a page shows of a Project of several, as its lists read it: its id and its Steps' ids. */
export type ShownWorkflow = { id: string; steps: ReadonlySet<string> };

/**
 * Whether a Task is listed on the page of the Workflow shown: one at a Step of it, or ended at
 * one; a Task at no Step and of no Workflow (a Parent, a question with a Member) on every page.
 * Every Task when none is shown.
 */
export function onShownWorkflow(task: Pick<Task, "step_id" | "workflow_id">, shown: ShownWorkflow | undefined): boolean {
  if (!shown) return true;
  if (task.step_id) return shown.steps.has(task.step_id);
  return !task.workflow_id || task.workflow_id === shown.id;
}
