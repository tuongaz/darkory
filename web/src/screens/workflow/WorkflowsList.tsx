import { ChevronRightIcon } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";
import type { Project } from "@/api/client";
import { workflowsPath } from "@/app/currentProject";
import { useNow } from "@/clock";
import { startOf } from "@/components/filters/dates";
import { useTasks } from "@/api/queries";
import { cn } from "@/lib/utils";
import type { WorkflowRecord } from "./bind";
import { workflowRows } from "./workflowRows";

// Workflow · Steps · Waiting · Working · Done today; the figures right-aligned under their heads.
const cols = "grid grid-cols-[minmax(0,1fr)_40px_52px_56px_72px] gap-2 px-4 sm:grid-cols-[minmax(0,1fr)_80px_80px_80px_96px] sm:gap-3 sm:px-6";
const figure = "text-right tabular-nums";

/**
 * /projects/:key/workflows of a Project of two or more: a row per Workflow, in order, with its
 * figures; a row opens that Workflow's page.
 */
export function WorkflowsList({ project, graph }: { project: Project; graph: WorkflowRecord }) {
  const now = useNow();
  // The same read as the line's "N today": what reached Done since midnight.
  const done = useTasks({ project: project.key, state: "done", filter: [`completed_at:gte:${startOf(new Date(now))}`] });
  const rows = useMemo(() => workflowRows(graph, done.data ?? []), [graph, done.data]);
  return (
    <div role="table" aria-label="Workflows" className="min-w-0 text-[13px]">
      <div role="row" className={cn(cols, "h-8 items-center border-b text-xs font-medium text-muted-foreground")}>
        <span role="columnheader">Workflow</span>
        <span role="columnheader" className={figure}>
          Steps
        </span>
        <span role="columnheader" className={figure}>
          Waiting
        </span>
        <span role="columnheader" className={figure}>
          Working
        </span>
        <span role="columnheader" className={figure}>
          Done today
        </span>
      </div>
      {rows.map((r) => (
        <div role="row" key={r.id} aria-label={r.name} className={cn(cols, "relative h-9 items-center border-b hover:bg-accent/60")}>
          <span role="cell" className="flex min-w-0 items-center gap-1">
            <Link to={workflowsPath(project, r.id)} className="truncate font-medium outline-none after:absolute after:inset-0 focus-visible:underline">
              {r.name}
            </Link>
            <ChevronRightIcon aria-hidden className="size-3.5 flex-none text-muted-foreground" />
          </span>
          <Figure n={r.steps} />
          <Figure n={r.waiting} />
          <Figure n={r.working} />
          <Figure n={done.data ? r.doneToday : undefined} />
        </div>
      ))}
    </div>
  );
}

function Figure({ n }: { n: number | undefined }) {
  return (
    <span role="cell" className={cn(figure, (n === undefined || n === 0) && "text-muted-foreground")}>
      {n ?? "…"}
    </span>
  );
}
