import { ArrowRightIcon, PlusIcon, XIcon } from "lucide-react";
import type { RefCallback } from "react";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { nameMax } from "../edits";
import { cn } from "@/lib/utils";
import type { RecordConnector, RecordStep, WorkflowRecord } from "../bind";
import { wasTarget } from "./draft";
import { StepOptions } from "./StepOptions";

const DONE = "@done";
const toValue = (to: string | undefined) => to ?? DONE;
const fromValue = (v: string) => (v === DONE ? undefined : v);

export type OutcomeActions = {
  rename: (id: string, name: string) => void;
  settle: () => void;
  target: (id: string, to: string | undefined) => void;
  remove: (id: string) => void;
  add: (from: string) => void;
};

export function AddOutcome({ step, onAdd }: { step: RecordStep; onAdd: (from: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onAdd(step.id)}
      aria-label={`Add an outcome out of ${step.name.trim() || "the new Step"}`}
      className="inline-flex h-7 items-center gap-1 self-start rounded-md px-1.5 text-[13px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <PlusIcon aria-hidden className="size-3.5" />
      Add an outcome
    </button>
  );
}

/**
 * One outcome: its name, the Step it leads to (its own Workflow's Steps, then each other
 * Workflow's under its name, then Done), where it led before this editing with undo, and remove.
 */
export function Outcome({
  wf,
  base,
  step,
  readOnly,
  invalid,
  actions,
  nameRef,
  c,
}: {
  wf: WorkflowRecord;
  base: WorkflowRecord;
  step: RecordStep;
  readOnly: boolean;
  invalid: boolean;
  actions: OutcomeActions;
  nameRef: (id: string) => RefCallback<HTMLInputElement>;
  c: RecordConnector;
}) {
  const fresh = !base.connectors.some((x) => x.id === c.id);
  const was = wasTarget(base, c);
  const nameOf = (id: string | undefined) =>
    id ? (wf.steps.find((s) => s.id === id) ?? base.steps.find((s) => s.id === id))?.name.trim() || "New Step" : "Done";
  const stepName = step.name.trim() || "the new Step";
  if (readOnly) {
    return (
      <span className="flex min-w-0 items-center gap-2 text-xs">
        <span className="rounded-full border px-2 leading-5">{c.name}</span>
        <ArrowRightIcon aria-label="to" className="size-3 flex-none text-muted-foreground" />
        <span>{nameOf(c.to_step_id)}</span>
      </span>
    );
  }
  const empty = !c.name.trim();
  return (
    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <input
        ref={nameRef(c.id)}
        value={c.name}
        placeholder="outcome"
        maxLength={nameMax}
        aria-label={`Outcome out of ${stepName}`}
        aria-invalid={(invalid && empty) || undefined}
        onChange={(e) => actions.rename(c.id, e.target.value)}
        onBlur={actions.settle}
        className="h-6 w-[150px] min-w-0 rounded-full max-md:w-[110px] border border-border bg-background px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30"
      />
      <ArrowRightIcon aria-hidden className="size-3 flex-none text-muted-foreground" />
      <Select value={toValue(c.to_step_id)} onValueChange={(v) => actions.target(c.id, fromValue(v))}>
        <SelectTrigger
          size="sm"
          aria-label={`Where ${c.name.trim() || "the outcome"} out of ${stepName} leads`}
          className={cn(
            "h-6! w-[180px] justify-between gap-1 bg-background px-2 py-0 text-xs shadow-none data-[size=sm]:h-6 max-md:w-[120px] [&_svg]:size-3!",
            (fresh || was) && "border-state-claimed bg-state-claimed-bg dark:bg-state-claimed-bg",
          )}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          <StepOptions wf={wf} first={step.workflow_id} offered={(s) => s.id !== step.id} />
          <SelectSeparator />
          <SelectItem value={DONE}>Done</SelectItem>
        </SelectContent>
      </Select>
      {was && (
        <>
          <s className="text-[11.5px] text-muted-foreground">
            <span className="sr-only">was </span>
            {nameOf(was.to)}
          </s>
          <button
            type="button"
            onClick={() => actions.target(c.id, was.to)}
            aria-label={`Undo: lead ${c.name.trim() || "the outcome"} back to ${nameOf(was.to)}`}
            className="rounded-sm text-[11.5px] text-muted-foreground underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            undo
          </button>
        </>
      )}
      <button
        type="button"
        onClick={() => actions.remove(c.id)}
        aria-label={`Remove ${c.name.trim() || "the outcome"} out of ${stepName}`}
        className="inline-flex size-6 flex-none items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <XIcon aria-hidden className="size-3" />
      </button>
    </span>
  );
}
