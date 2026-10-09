// Which of a Project's Workflows a page shows (ADR 0019, decision 8): `?workflow=`, else the one
// this browser last picked in the Project, else the first. WorkflowChip picks it.
import { useCallback } from "react";
import { useSearchParams } from "react-router";
import type { Project, Task, Workflow, WorkflowStep } from "@/api/client";
import { workflowsInOrder } from "@/components/workflowLine/model";
import { toShort } from "@/lib/shortid";
import { listedOn } from "@/screens/board/derive";

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

/** A Project's Workflows and Steps, as `GET …/workflow` serves them. */
export type WorkflowGraph = { workflows: readonly Pick<Workflow, "id" | "position">[]; steps: readonly Pick<WorkflowStep, "id" | "workflow_id" | "position">[] };

/**
 * The Workflow a page shows of a Project of several, as its lists read it: its id, its Steps' ids,
 * whether a Task is listed there (`shows`), the Workflows a Task the page has, by id, is listed on
 * (`of`; undefined for every one, or a Task it does not have), and the lines a Parent's open
 * Subtasks are on (`lines`: the Workflows of their Steps), where the scope menu offers it.
 */
export type ShownWorkflow = {
  id: string;
  steps: ReadonlySet<string>;
  graph: WorkflowGraph;
  shows: (task: Pick<Task, "state" | "workflow_id">) => boolean;
  of: (taskId: string) => ReadonlySet<string> | undefined;
  lines: (parentId: string) => ReadonlySet<string>;
};

const none: ReadonlySet<string> = new Set();

/**
 * The Workflow `id` of `graph` as a page shows it, each Task listed where the server places it
 * (`listedOn`, its `workflow_id`), as the board lists it. `tasks` are the Tasks the page has, open
 * and any ended it read: `of` looks one up, and `lines` reads the open Subtasks among them.
 */
export function shownWorkflow(id: string, graph: WorkflowGraph, tasks: readonly Task[]): ShownWorkflow {
  const steps = new Set(graph.steps.filter((s) => s.workflow_id === id).map((s) => s.id));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const stepWorkflow = new Map(graph.steps.map((s) => [s.id, s.workflow_id]));
  const lines = new Map<string, Set<string>>();
  for (const t of tasks) {
    const at = t.parent_id && t.state === "open" && t.step_id ? stepWorkflow.get(t.step_id) : undefined;
    if (!at) continue;
    const set = lines.get(t.parent_id!) ?? new Set<string>();
    set.add(at);
    lines.set(t.parent_id!, set);
  }
  return {
    id,
    steps,
    graph,
    shows: (task) => {
      const at = listedOn(task, graph);
      return !at || at.has(id);
    },
    of: (taskId) => {
      const task = byId.get(taskId);
      return task && listedOn(task, graph);
    },
    lines: (parentId) => lines.get(parentId) ?? none,
  };
}
