import { ArrowRightIcon, TriangleAlertIcon } from "lucide-react";
import { MemberAvatar } from "@/components/MemberAvatar";
import { outgoing, stepsInOrder, targetName, unstaffed, waitingAt, type Step, type Workflow } from "@/components/workflow/model";
import { spanText } from "@/lib/time";
import { NoWayOut } from "@/components/workflow/nodes";
import type { CanvasSelection } from "@/components/workflow/WorkflowCanvas";
import { cn } from "@/lib/utils";

/**
 * The Workflow as a list, for a screen reader and a phone: each Step in order with its Skill (or
 * that it is a hold), who takes its Tasks, its counts and median, live the Tasks at it (each opens
 * its peek), and the Connectors out of it by outcome. Live, a Step opens its peek; editing, a Step
 * or a Connector is selected for the panel.
 */
export function TextView({
  workflow,
  mode,
  selection,
  onStep,
  onConnector,
  onTask,
}: {
  workflow: Workflow;
  mode: "live" | "edit";
  selection?: CanvasSelection;
  onStep: (step: Step) => void;
  onConnector?: (id: string) => void;
  /** Live, a Task at a Step was chosen: open its peek. */
  onTask?: (key: string) => void;
}) {
  const steps = stepsInOrder(workflow);
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3 px-4 py-5 sm:px-6">
      {steps.length === 0 && <p className="text-muted-foreground">No Steps yet: nothing can be filed in this Project.</p>}
      <ol aria-label="Steps" className="flex flex-col gap-2">
        {steps.map((s, i) => {
          const out = outgoing(workflow, s.id);
          const chosen = selection?.kind === "step" && selection.id === s.id;
          return (
            <li key={s.id} className={cn("rounded-lg border bg-card", !s.skill && "border-dashed", chosen && "border-ring ring-2 ring-ring/40")}>
              <button
                type="button"
                onClick={() => onStep(s)}
                aria-label={mode === "edit" ? `Edit ${s.name}` : `Open ${s.name}`}
                aria-pressed={mode === "edit" ? chosen : undefined}
                className="flex w-full min-w-0 flex-col gap-1 rounded-t-lg px-3 py-2.5 text-left hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <span className="text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                  <span className="truncate font-semibold">{s.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{s.skill ? s.skill.name : "Hold · moved on by hand"}</span>
                  <span className="basis-full text-xs text-muted-foreground tabular-nums sm:ml-auto sm:basis-auto">
                    {waitingAt(s)} waiting · {s.working} working
                  </span>
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {unstaffed(s) ? (
                    <span className="flex items-center gap-1 font-medium text-state-claimed">
                      <TriangleAlertIcon aria-hidden className="size-3.5" />
                      No Member has {s.skill!.name}
                    </span>
                  ) : s.takers.length > 0 ? (
                    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                      {s.takers.map((t) => (
                        <span key={t.id} className="inline-flex items-center gap-1">
                          <MemberAvatar member={t} working={mode === "live" ? t.working : undefined} />
                          <span className="text-foreground">{t.name}</span>
                        </span>
                      ))}
                    </span>
                  ) : null}
                  {s.medianMs !== undefined && <span>Median {spanText(s.medianMs)}</span>}
                </span>
              </button>
              {mode === "live" && s.chips && s.chips.length > 0 && (
                <ul aria-label={`Tasks at ${s.name}`} className="flex flex-col border-t px-1.5 py-1">
                  {s.chips.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => onTask?.(c.key)}
                        aria-label={`${c.key} ${c.title}, ${c.holder ? `held by ${c.holder.name}` : "waiting"}`}
                        className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                      >
                        {c.holder ? (
                          <MemberAvatar member={c.holder} working={c.holder.working} />
                        ) : (
                          <span aria-hidden className="size-5 flex-none rounded-full border border-dashed border-muted-foreground/60" />
                        )}
                        {c.parentKey && <span className="flex-none font-mono text-[11px] text-muted-foreground/80">{c.parentKey} ›</span>}
                        <span className="flex-none font-mono text-[11.5px] font-medium">{c.key}</span>
                        <span className="min-w-0 truncate">{c.title}</span>
                        {c.holder && <span className="ml-auto flex-none text-muted-foreground">{c.holder.name}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <ul aria-label={`Connectors out of ${s.name}`} className="flex flex-col border-t px-3 py-1.5">
                {out.length === 0 &&
                  (s.skill ? (
                    <li className="py-0.5 text-xs">
                      <NoWayOut />
                    </li>
                  ) : (
                    <li className="py-0.5 text-xs text-muted-foreground">No Connector out: its Tasks are moved on by hand.</li>
                  ))}
                {out.map((c) => {
                  const line = (
                    <>
                      <span className="font-medium">{c.name}</span>
                      <ArrowRightIcon aria-hidden className="size-3 flex-none text-muted-foreground" />
                      <span className="truncate text-muted-foreground">{targetName(workflow, c.to)}</span>
                    </>
                  );
                  const picked = selection?.kind === "connector" && selection.id === c.id;
                  return (
                    <li key={c.id} className="flex min-w-0 items-center text-xs">
                      {mode === "edit" && onConnector ? (
                        <button
                          type="button"
                          aria-label={`Edit ${c.name}, ${s.name} to ${targetName(workflow, c.to)}`}
                          aria-pressed={picked}
                          onClick={() => onConnector(c.id)}
                          className={cn(
                            "-mx-1 flex min-w-0 items-center gap-1.5 rounded-sm px-1 py-0.5 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                            picked && "bg-accent",
                          )}
                        >
                          {line}
                        </button>
                      ) : (
                        <span className="flex min-w-0 items-center gap-1.5 py-0.5">{line}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-muted-foreground">
        A Task advanced into Done is complete. Its Owner drops it from any Step, into Dropped.
      </p>
    </div>
  );
}
