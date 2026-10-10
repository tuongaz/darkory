import type { ComponentProps, ReactNode } from "react";
import { InfoTip } from "@/components/InfoTip";
import { cn } from "@/lib/utils";
import { AFTER_HINT, ALSO_LABEL, START_LABEL } from "./words";

/*
 * What the live line and the editor's line draw alike: the Start row, a crossing in, a mark beside
 * a Step, the "Also starts here" group (the Retrospective at Done is `model.ts`'s `retroAt` and a Mark).
 */

/** A mark beside a Step, for what leaves the line: into Done, another Workflow, by hand, a Breakdown's Subtasks. */
export type MarkKind = "done" | "exit" | "hand" | "files" | "chip" | "return";

const glyphs: Record<MarkKind, string> = { done: "●", exit: "↗", hand: "⇢", files: "↳", chip: "↗", return: "↩" };

/** A mark: its glyph and its words; on the quiet line (When a Parent ends) without its fill, in muted ink. */
export function Mark({ kind, text, quiet, className, ...rest }: { kind: MarkKind; text: string; quiet?: boolean } & ComponentProps<"span">) {
  return (
    <span
      data-mark={kind}
      {...rest}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-[5px] px-[7px] py-0.5 text-xs leading-[1.4]",
        quiet ? "pl-0 text-muted-foreground" : kind === "done" ? "bg-state-done-bg" : kind === "hand" ? "border border-dashed border-muted-foreground px-1.5 py-px text-muted-foreground" : "bg-muted",
        className,
      )}
    >
      <span aria-hidden className={cn("font-semibold", kind === "done" ? "text-state-done" : "text-muted-foreground")}>
        {glyphs[kind]}
      </span>{" "}
      <span className="min-w-0 truncate">{text}</span>
    </span>
  );
}

/** A crossing in from another Workflow, beside the Step it reaches: "Bug triage · feature ↙". */
export function EntryChip({ text, lit, className, ...rest }: { text: string; lit?: boolean } & ComponentProps<"span">) {
  return (
    <span
      data-chip="entry"
      {...rest}
      className={cn("inline-flex h-5 items-center gap-1 rounded-full border px-[7px] text-[11px] font-medium whitespace-nowrap text-muted-foreground", lit && "border-state-claimed text-state-claimed", className)}
    >
      {text.replace(/^from /, "")}
      <span aria-hidden>↙</span>
    </span>
  );
}

/**
 * The row over the first station: ↓ Start, or, on a Workflow of only branch Steps, its heading with
 * its sentence behind the ⓘ; then what crosses in there. `label` goes on the words (a hover, a fade).
 */
export function StartRow({ heading, label, children }: { heading?: string; label?: Record<string, unknown>; children?: ReactNode }) {
  return (
    <div data-start-row className="flex min-h-6 flex-wrap items-center gap-x-2.5 gap-y-1 pb-0.5">
      <span data-start-label {...label} className="inline-flex items-center gap-1.5 text-[13px] font-semibold">
        <span aria-hidden>↓</span>
        {heading ?? START_LABEL}
        {heading && <InfoTip label={heading}>{AFTER_HINT}</InfoTip>}
      </span>
      {children}
    </div>
  );
}

/**
 * "Also starts here": a light group beside the start Step's row, an arrow pointing back at Start;
 * under it in a narrow line (`@3xl`, the line's `NARROW_PX`). Each child is a Step's row.
 */
export function AlsoStartsHere({ dim, roomy, children }: { dim?: boolean; roomy?: boolean; children: ReactNode }) {
  return (
    <div data-dim={dim ? "" : undefined} className="flex w-full min-w-0 basis-full items-start @3xl:basis-auto">
      <span aria-hidden className="relative mt-3 mr-2 hidden h-[1.5px] w-7 flex-none bg-muted-foreground @3xl:block">
        <span className="absolute top-[-4px] left-[-2px] border-y-[4.5px] border-r-[7px] border-y-transparent border-r-muted-foreground" />
      </span>
      <section aria-label={ALSO_LABEL} className="min-w-0 flex-1 rounded-md border px-2.5 pt-1 pb-1.5">
        <div className="text-[11px] font-medium text-muted-foreground">{ALSO_LABEL}</div>
        <div className={cn("flex flex-col", roomy ? "gap-1.5" : "gap-1")}>{children}</div>
      </section>
    </div>
  );
}
