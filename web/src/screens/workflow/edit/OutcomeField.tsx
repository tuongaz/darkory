import { ArrowRightIcon, XIcon } from "lucide-react";
import type { RefCallback } from "react";
import { Tip } from "@/components/Tip";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { RecordConnector, RecordStep, WorkflowRecord } from "../bind";
import { nameMax } from "../edits";
import { wasTarget } from "./draft";
import { stepWord, type OnLineActions } from "./lineEdit";
import { StepOptions } from "./StepOptions";

const DONE = "@done";
const toValue = (to: string | undefined) => to ?? DONE;
const fromValue = (v: string) => (v === DONE ? undefined : v);

/**
 * One outcome where the line draws it: the main-way dot (of a Step with two or more), its glyph
 * beside the Step (↩ back, ↪ on, ● Done, ↗ off the line), its name, the Step it leads to (its own
 * Workflow's Steps, then each other Workflow's under its name, then Done), where it led before
 * this editing with undo, and ×.
 */
export function OutcomeField({
  c,
  wf,
  base,
  step,
  main,
  glyph,
  changed,
  invalid,
  actions,
  inputRef,
  nameOf,
}: {
  c: RecordConnector;
  wf: WorkflowRecord;
  base: WorkflowRecord;
  step: RecordStep;
  /** Whether it is the main way on, of a Step with two or more; undefined with one. */
  main: boolean | undefined;
  glyph?: string;
  changed: boolean;
  invalid: boolean;
  actions: OnLineActions;
  inputRef: (id: string) => RefCallback<HTMLElement>;
  nameOf: (id: string | undefined) => string;
}) {
  const word = stepWord(step);
  const name = c.name.trim();
  const was = wasTarget(base, c);
  const wasName = was && ((was.to && (wf.steps.find((s) => s.id === was.to) ?? base.steps.find((s) => s.id === was.to))?.name.trim()) || (was.to ? "New Step" : "Done"));
  return (
    <span
      data-outcome={c.id}
      data-changed={changed ? "" : undefined}
      className={cn("inline-flex max-w-full flex-wrap items-center gap-1 rounded-md px-0.5 text-xs", changed && "text-state-waiting ring-1 ring-state-waiting")}
    >
      {main !== undefined && (
        <Tip label={main ? "Main: the line follows it" : "Make it the main way on"}>
          <button
            type="button"
            aria-pressed={main}
            aria-label={`${name || "the outcome"} out of ${word}: the main way on`}
            onClick={() => actions.main(c.id)}
            className="flex size-4 flex-none items-center justify-center rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <span className={cn("size-2.5 rounded-full border-[1.5px] border-muted-foreground", main && "border-foreground bg-foreground")} />
          </button>
        </Tip>
      )}
      {glyph && (
        <span aria-hidden className={cn("font-semibold", !changed && "text-muted-foreground")}>
          {glyph}
        </span>
      )}
      <input
        ref={inputRef(c.id)}
        value={c.name}
        placeholder="outcome"
        maxLength={nameMax}
        aria-label={name ? `Outcome ${name} out of ${word}` : `Outcome out of ${word}`}
        aria-invalid={(invalid && !name) || undefined}
        onChange={(e) => actions.renameOutcome(c.id, e.target.value)}
        onBlur={actions.settle}
        style={{ width: `calc(${Math.max(c.name.length, 4)}ch + 12px)` }}
        className={cn(
          "h-6 max-w-[180px] min-w-0 rounded-md border border-transparent bg-transparent px-1 text-xs outline-none placeholder:text-muted-foreground hover:border-input",
          "focus-visible:border-ring focus-visible:bg-background focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive",
        )}
      />
      <ArrowRightIcon aria-hidden className="size-3 flex-none text-muted-foreground" />
      <Select value={toValue(c.to_step_id)} onValueChange={(v) => actions.target(c.id, fromValue(v))}>
        <SelectTrigger
          size="sm"
          aria-label={`Where ${name || "the outcome"} out of ${word} leads`}
          className={cn(
            "h-6! w-auto max-w-[200px] gap-1 border-transparent bg-transparent px-1 py-0 text-xs font-medium shadow-none hover:border-input data-[size=sm]:h-6 dark:bg-transparent [&_svg]:size-3!",
          )}
        >
          <SelectValue>{nameOf(c.to_step_id)}</SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          <StepOptions wf={wf} first={step.workflow_id} offered={(s) => s.id !== step.id} />
          <SelectSeparator />
          <SelectItem value={DONE}>Done</SelectItem>
        </SelectContent>
      </Select>
      {was && (
        <>
          <s className="text-[11px] text-muted-foreground">
            <span className="sr-only">was </span>
            {wasName}
          </s>
          <button
            type="button"
            onClick={() => actions.target(c.id, was.to)}
            aria-label={`Undo: lead ${name || "the outcome"} back to ${wasName}`}
            className="rounded-sm text-[11px] text-muted-foreground underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            undo
          </button>
        </>
      )}
      <button
        type="button"
        onClick={() => actions.removeOutcome(c.id)}
        aria-label={`Remove ${name || "the outcome"} out of ${word}`}
        className="inline-flex size-5 flex-none items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <XIcon aria-hidden className="size-3" />
      </button>
    </span>
  );
}
