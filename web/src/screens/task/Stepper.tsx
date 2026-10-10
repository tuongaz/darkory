// A Task's path through its Workflow's Steps, with the time it spent at each: where it was filed,
// how it left each Step (an advance's outcome, a move by hand), where it is now and since when,
// and how it ended. Where the path crosses into another Workflow, that Workflow's name stands
// before its first Step.
import { ArrowRightIcon } from "lucide-react";
import { Fragment } from "react";
import type { Activity, TaskDetail, WorkflowStep } from "@/api/client";
import { useNow } from "@/clock";
import { WorkGlyph } from "@/components/WorkGlyph";
import { cn } from "@/lib/utils";
import { taskPath, type Stay } from "./path";
import { useTaskWorkflow } from "./queries";
import { useWaitsFor } from "./useWaitsFor";
import { spanText } from "@/lib/time";

const leftWords = (left: Stay["left"]) => {
  switch (left?.by) {
    case "advanced":
    case "completed":
      return left.outcome;
    case "moved":
      return "moved";
    default:
      return undefined;
  }
};

/** The note under a worked Task's line, where the line is what the eye reads (the strip says it for a screen reader). */
export function WaitsForNote({ detail, steps }: { detail: TaskDetail; steps: readonly WorkflowStep[] }) {
  const words = useWaitsFor(detail, steps);
  if (!words) return null;
  return (
    <p aria-hidden className="text-xs text-muted-foreground">
      {words}
    </p>
  );
}

export function Stepper({ detail, path, steps }: { detail: TaskDetail; path: readonly Activity[]; steps: readonly WorkflowStep[] }) {
  const now = useNow();
  const { workflows } = useTaskWorkflow(detail.task.project_id);
  const { stays, end } = taskPath(detail.task, path);
  const waits = useWaitsFor(detail, steps);
  // A path with no Step on it (a Parent from its filing, history out of reach) says nothing.
  if (stays.length === 0) return null;
  const name = (id: string) => steps.find((s) => s.id === id)?.name ?? "A Step since removed";
  const hold = (id: string) => !steps.find((s) => s.id === id)?.skill_id;
  const workflowOf = (id: string) => steps.find((s) => s.id === id)?.workflow_id;
  // The Workflow a stay crossed into from the one before it, of a Project of several; none if either Step is gone.
  const crossed = (i: number) => {
    if (i === 0 || workflows.length < 2) return undefined;
    const [was, is] = [workflowOf(stays[i - 1].stepId), workflowOf(stays[i].stepId)];
    return was && is && was !== is ? workflows.find((w) => w.id === is)?.name : undefined;
  };
  return (
    <ol aria-label="Path through the Steps" className="flex flex-wrap items-center gap-x-1 gap-y-1.5 text-xs">
      {stays.map((s, i) => {
        const current = s.until === undefined;
        const out = leftWords(s.left);
        const into = crossed(i);
        return (
          <Fragment key={i}>
            {i > 0 && <Arrow />}
            {/* The Workflow it crossed into reads with the Step, in its item: "Bugs › Investigate". */}
            <li aria-current={current ? "step" : undefined} className="inline-flex items-center gap-1">
              {into && (
                <span data-crossing className="text-2xs font-medium text-muted-foreground">
                  {into} ›
                </span>
              )}
              <span
                className={cn(
                  "inline-flex h-6 items-center gap-1.5 rounded-full border px-2",
                  hold(s.stepId) && "border-dashed",
                  current ? "border-ring bg-state-waiting-bg font-medium text-foreground" : "text-muted-foreground",
                )}
                title={`${name(s.stepId)}: ${new Date(s.since).toLocaleString()}${s.until ? ` to ${new Date(s.until).toLocaleString()}` : ", now"}`}
              >
                <span className="max-w-32 truncate">{name(s.stepId)}</span>
                <span className="tabular-nums">{spanText((s.until ?? now) - s.since)}</span>
                {current && <span className="sr-only">, now</span>}
              </span>
            </li>
            {out && <li className="inline-flex text-2xs text-muted-foreground">{out}</li>}
            {current && waits && <li className="inline-flex text-2xs text-muted-foreground">{waits}</li>}
          </Fragment>
        );
      })}
      {end && (
        <>
          {stays.length > 0 && <Arrow />}
          <li className="inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-muted-foreground">
            {end.kind === "parent" ? (
              "Subtasks"
            ) : (
              <>
                <WorkGlyph glyph={{ glyph: end.kind }} />
                {end.kind === "done" ? "Done" : "Dropped"}
              </>
            )}
          </li>
        </>
      )}
    </ol>
  );
}

function Arrow() {
  return (
    <li aria-hidden className="inline-flex text-muted-foreground">
      <ArrowRightIcon className="size-3" />
    </li>
  );
}
