// A Task's path through its Workflow's Steps, with the time it spent at each: where it was filed,
// how it left each Step (an advance's outcome, a move by hand), where it is now and since when,
// and how it ended.
import { ArrowRightIcon } from "lucide-react";
import { Fragment } from "react";
import type { Activity, TaskDetail, WorkflowStep } from "@/api/client";
import { useNow } from "@/clock";
import { WorkGlyph } from "@/components/WorkGlyph";
import { cn } from "@/lib/utils";
import { stayText, taskPath, type Stay } from "./path";

const leftWords = (left: Stay["left"]) => {
  switch (left?.by) {
    case "advanced":
      return left.outcome;
    case "moved":
      return "moved";
    default:
      return undefined;
  }
};

export function Stepper({ detail, path, steps }: { detail: TaskDetail; path: readonly Activity[]; steps: readonly WorkflowStep[] }) {
  const now = useNow();
  const { stays, end } = taskPath(detail.task, path);
  // A path with no Step on it (a Parent from its filing, history out of reach) says nothing.
  if (stays.length === 0) return null;
  const name = (id: string) => steps.find((s) => s.id === id)?.name ?? "A Step since removed";
  const hold = (id: string) => !steps.find((s) => s.id === id)?.skill_id;
  return (
    <ol aria-label="Path through the Steps" className="flex flex-wrap items-center gap-x-1 gap-y-1.5 text-xs">
      {stays.map((s, i) => {
        const current = s.until === undefined;
        const out = leftWords(s.left);
        return (
          <Fragment key={i}>
            {i > 0 && <Arrow />}
            <li
              aria-current={current ? "step" : undefined}
              className={cn(
                "inline-flex h-6 items-center gap-1.5 rounded-full border px-2",
                hold(s.stepId) && "border-dashed",
                current ? "border-ring bg-state-waiting-bg font-medium text-foreground" : "text-muted-foreground",
              )}
              title={`${name(s.stepId)}: ${new Date(s.since).toLocaleString()}${s.until ? ` to ${new Date(s.until).toLocaleString()}` : ", now"}`}
            >
              <span className="max-w-32 truncate">{name(s.stepId)}</span>
              <span className="tabular-nums">{stayText((s.until ?? now) - s.since)}</span>
              {current && <span className="sr-only">, now</span>}
            </li>
            {out && <li className="inline-flex text-2xs text-muted-foreground">{out}</li>}
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
