import { useMemo } from "react";
import type { Project } from "@/api/client";
import { useOpenTasks } from "@/api/queries";
import type { ShownWorkflow } from "@/components/pickedWorkflow";
import { blockingTasks, shownBy } from "./bind";
import { analyseBlocking } from "./layout";

const noMembers = new Map();
const noSessions = new Map();
const nobody = new Set<string>();

/**
 * How many Blockings `project` has among its open Tasks (those `shown` lists, on the page of one
 * Workflow of several), those with a Task outside it included:
 * the Blocking toggle's count, and whether it shows at all. Reads the Organisation's open Tasks,
 * which the sidebar already holds.
 */
export function useBlockingCount(project: Pick<Project, "id">, scope?: string, shown?: ShownWorkflow): number | undefined {
  const open = useOpenTasks().data;
  return useMemo(() => {
    if (!open) return undefined;
    const tasks = blockingTasks(open, { members: noMembers, now: 0, sessions: noSessions, takeableByMe: nobody });
    const shows = shownBy(shown, new Map(open.map((t) => [t.id, t])));
    return analyseBlocking(tasks, { projectId: project.id, scope, me: "", shows }).edges.length;
  }, [open, project.id, scope, shown]);
}
