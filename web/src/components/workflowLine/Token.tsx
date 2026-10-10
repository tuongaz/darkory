import type { KeyboardEventHandler, ReactNode, Ref } from "react";
import { MemberAvatar } from "@/components/MemberAvatar";
import type { Tone } from "@/components/workflow/live";
import { cn } from "@/lib/utils";
import { blockedWords, PICKUP_MS, tokenLabel, tokenState, tokenTime, type LineTask, type TokenState } from "./model";

/**
 * A Task at its Step, as vf-4 draws it: a bordered chip, its holder's mark (ringed while it works;
 * the mark says held, so no fill) or a ring in its state's colour,
 * its key, its time there, and when blocked who it waits on, in red, held or not. Just picked up it reads "now" with a
 * halo; a live moment pulses it in that moment's colour.
 */
export function Token({
  task,
  hold,
  now,
  selected,
  ringed,
  dim,
  pulse,
  arrived,
  tag,
  past,
  onClick,
  onHover,
  compact,
  noKey,
  tagSide = "left",
}: {
  task: LineTask;
  hold: boolean;
  now: number;
  selected?: boolean;
  ringed?: boolean;
  dim?: boolean;
  pulse?: Tone;
  arrived?: boolean;
  /** A note hung off the token's left side: "now · builder picked up · waited 43m". */
  tag?: ReactNode;
  /** A past stay on a single Task's path: dashed, the time it was worked there. */
  past?: { text: string };
  onClick?: () => void;
  onHover?: (on: boolean) => void;
  /** Key and mark only: the line is too narrow for times. */
  compact?: boolean;
  /** Mark and time only: the page around it is already about this Task. */
  noKey?: boolean;
  tagSide?: "left" | "right";
}) {
  const state = tokenState(task, hold);
  const picked = task.heldSince !== undefined && now - task.heldSince < PICKUP_MS;
  const since = task.holder ? task.heldSince : task.since;
  const time = past ? past.text : picked ? "now" : since !== undefined ? tokenTime(now - since) : undefined;
  const by = blockedWords(task);
  return (
    <span className={cn("relative inline-flex", dim && "wl-dim")}>
      {tag && (
        <span
          data-tag
          data-box="tag"
          className={cn(
            "pointer-events-none absolute top-1/2 z-10 flex -translate-y-1/2 items-center gap-1.5 text-xs font-medium whitespace-nowrap",
            tagSide === "left" ? "right-full mr-1" : "left-full ml-1 flex-row-reverse",
          )}
        >
          {tag}
        </span>
      )}
      <button
        type="button"
        data-task={task.key}
        data-box="token"
        data-state={state}
        data-now={picked && !past ? "" : undefined}
        data-pulse={pulse && pulse !== "filed" ? pulse : undefined}
        data-arrived={arrived ? "" : undefined}
        data-selected={selected ? "" : undefined}
        data-ringed={ringed && !selected ? "" : undefined}
        data-past={past ? "" : undefined}
        data-blocked={by ? "" : undefined}
        aria-label={tokenLabel(task, state)}
        aria-pressed={onClick ? !!selected : undefined}
        onClick={onClick}
        onMouseEnter={onHover && (() => onHover(true))}
        onMouseLeave={onHover && (() => onHover(false))}
        className={cn(
          "wl-token inline-flex min-h-7 items-center gap-1.5 rounded-[6px] border bg-background pr-2 pl-1 text-xs whitespace-nowrap data-[past]:border-dashed data-[state=hold]:border-dashed data-[state=idle]:border-dashed",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          !onClick && "cursor-default",
        )}
      >
        {task.holder ? <MemberAvatar member={task.holder} working={task.holder.working} /> : <span aria-hidden className="wl-ring mx-0.5 size-3.5 flex-none rounded-full" />}
        {!noKey && <span className="font-mono text-[11.5px] text-foreground">{task.key}</span>}
        {!compact && time && (
          <span className={cn("tabular-nums", picked && !past ? "font-medium text-state-claimed" : "text-muted-foreground")}>{time}</span>
        )}
        {by && <span className="text-[11px] font-medium text-state-blocked">{by}</span>}
      </button>
    </span>
  );
}

/** A Subtask still to come on a Parent's line: a dashed ghost saying when it will be filed. */
export function GhostToken({ text, label }: { text: string; label: string }) {
  return (
    <span data-ghost aria-label={`${label} ${text}`} className="wl-token inline-flex h-6 items-center rounded-[6px] border border-dashed px-2 text-xs whitespace-nowrap">
      {text}
    </span>
  );
}

/** A Task as a bead on a crowded line: filled amber held, hollow blue waiting, red blocked, dashed in the hold. */
export function Bead({ task, hold, dim }: { task: LineTask; hold: boolean; dim?: boolean }) {
  const state = tokenState(task, hold);
  return <span data-task={task.key} data-state={state} aria-label={tokenLabel(task, state)} role="img" className={cn("wl-bead size-3 rounded-full", dim && "wl-dim")} />;
}

/** The faint count a narrowed line leaves on a Step: "+1". */
export function HiddenCount({ n }: { n: number }) {
  return (
    <span aria-label={`${n} more ${n === 1 ? "Task" : "Tasks"} outside this scope`} className="rounded-full border border-dashed px-1.5 text-[10.5px] leading-4 text-muted-foreground">
      +{n}
    </span>
  );
}

/** A Task's state as a small ring: blue waiting, red blocked, dashed in a hold, amber held. */
export function Glyph({ state }: { state: TokenState }) {
  return (
    <span
      aria-hidden
      data-state={state}
      className={cn(
        "size-3.5 flex-none rounded-full border-[1.5px]",
        state === "blocked" ? "border-state-blocked" : state === "hold" ? "border-dashed border-muted-foreground" : state === "held" || state === "idle" ? "border-state-claimed" : "border-state-waiting",
      )}
    />
  );
}

/**
 * The one count a Step shows past its chips: "13 waiting ›", or "2 more ›" when it also holds
 * held Tasks past the three drawn. A control: a click opens the Step's list in place under it.
 */
export function Count({
  stepId,
  stepName,
  text,
  hold,
  open,
  controls,
  ringed,
  pulse,
  onToggle,
  onKeyDown,
  buttonRef,
}: {
  stepId: string;
  stepName: string;
  text: string;
  hold: boolean;
  open: boolean;
  controls: string;
  ringed?: boolean;
  /** A Task just folded into it: one brief pulse. */
  pulse?: boolean;
  onToggle: () => void;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      data-count={stepId}
      data-ringed={ringed ? "" : undefined}
      data-pulse={pulse ? "" : undefined}
      aria-label={`${stepName}: ${text}`}
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      onClick={onToggle}
      onKeyDown={onKeyDown}
      className={cn(
        "wl-count inline-flex h-[26px] items-center gap-1.5 rounded-full border bg-background pr-[9px] pl-1.5 text-xs font-medium whitespace-nowrap hover:bg-accent",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        open && "border-foreground bg-accent",
      )}
    >
      <Glyph state={hold ? "hold" : "waiting"} />
      {text}
      <span aria-hidden className="ml-0.5 text-muted-foreground">
        ›
      </span>
    </button>
  );
}
