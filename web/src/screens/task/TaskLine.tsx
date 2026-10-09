import { ArrowRightIcon } from "lucide-react";
import { Link } from "react-router";
import type { TaskDetail } from "@/api/client";
import { useProjects } from "@/api/queries";
import { findProject } from "@/app/currentProject";
import { useNow } from "@/clock";
import { useLineData, WorkflowLine } from "@/components/workflowLine";
import { branchSkills } from "@/components/workflowLine/model";
import { workflowScopePath } from "./format";

/**
 * One worked Task's way through its Workflow (r2-scope F3): the line with its token alone, the
 * path so far traced with the time waited and worked at each Step, the outcomes open to it now
 * dashed, the other Tasks a faint "+N" per Step; vertical on a phone. "Workflow →" opens the
 * Project's line at this Task.
 */
export function TaskLine({ detail }: { detail: TaskDetail }) {
  const { task } = detail;
  const { data } = useLineData(task.project_id, task.workflow_id, task.key);
  const project = findProject(useProjects().data ?? [], task.project_id);
  const now = useNow();
  if (!data?.trace || data.trace.stays.length === 0) return null;
  const onBranch = data.trace.stays.some((s) => branchSkills.includes(data.facts.steps.find((x) => x.id === s.stepId)?.skill?.name ?? ""));
  return (
    <div className="flex flex-col">
      <WorkflowLine
        label={`${task.key}'s way through the Workflow`}
        workflow={data.facts}
        tasks={data.scoped.drawn}
        all={data.all}
        hidden={data.scoped.hidden}
        trace={data.trace}
        compactHeads
        density="tokens"
        verticalBelow={440}
        noBranch={!onBranch}
        noLoops
        now={now}
        me={data.me}
      />
      {project && (
        <Link to={workflowScopePath(project, task.id, task.workflow_id)} aria-label={`Workflow, at ${task.key}`} className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          Workflow
          <ArrowRightIcon aria-hidden className="size-3" />
        </Link>
      )}
    </div>
  );
}
