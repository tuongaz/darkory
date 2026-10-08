import { Handle, Position, type NodeProps } from "@xyflow/react";
import { PlusIcon, TriangleAlertIcon } from "lucide-react";
import { MemberAvatar } from "@/components/MemberAvatar";
import { WorkGlyph } from "@/components/WorkGlyph";
import { cn } from "@/lib/utils";
import { useCanvas } from "./context";
import type { StepFlowNode, TerminalFlowNode } from "./flow";
import { SHOWN_CHIPS } from "./layout";
import type { LiveCanvas } from "./live";
import { isHold, noWayOut, unstaffed, waitingAt, type Step, type Taker, type TaskChip } from "./model";
import { spanText } from "@/lib/time";

const shownTakers = 4;

/** The Members holding a Step's Skill, overlapping; past four, "+N" naming the rest on hover. */
function Takers({ takers, live }: { takers: Taker[]; live: boolean }) {
  const shown = takers.slice(0, takers.length > shownTakers ? shownTakers - 1 : shownTakers);
  const rest = takers.slice(shown.length);
  return (
    <span className="flex min-w-0 items-center -space-x-1">
      {shown.map((t) => (
        <MemberAvatar key={t.id} member={t} working={live ? t.working : undefined} className="ring-2 ring-card" />
      ))}
      {rest.length > 0 && (
        <span
          title={rest.map((t) => t.name).join(", ")}
          className="inline-grid size-5 place-items-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground ring-2 ring-card"
        >
          +{rest.length}
        </span>
      )}
    </span>
  );
}

/** A chip's words for a screen reader: its key, title and Parent, and who holds it or that it waits. */
function chipLabel(chip: TaskChip): string {
  const under = chip.parentKey ? `, under ${chip.parentKey}` : "";
  const who = chip.holder ? `held by ${chip.holder.kind === "agent" ? `${chip.holder.name} (agent)` : chip.holder.name}` : "waiting";
  return `${chip.key} ${chip.title}${under}, ${who}`;
}

/**
 * Live, the open Tasks at a Step as chips, one row each: the holder's mark ringed by how they
 * work there (an empty dashed ring while it waits), the Parent's key muted on a Subtask, the key
 * and a short title. A chip that has just been picked up, let go of or arrived comes first and
 * pulses; past three, "+N more" opens the Step. A chip opens its Task's peek.
 */
function Chips({ step, live, onOpenStep }: { step: Step; live?: LiveCanvas; onOpenStep?: (id: string) => void }) {
  const chips = step.chips ?? [];
  if (chips.length === 0) return null;
  const fresh = (c: TaskChip) => (live?.pulses.has(c.id) || live?.arrived.has(c.id) ? 0 : 1);
  const ordered = [...chips].sort((a, b) => fresh(a) - fresh(b));
  const shown = ordered.slice(0, SHOWN_CHIPS);
  const more = chips.length - shown.length;
  return (
    <ul aria-label={`Tasks at ${step.name}`} className="flex flex-col">
      {shown.map((c) => (
        <li key={c.id} className="flex h-6 min-w-0 items-center">
          <button
            type="button"
            aria-label={chipLabel(c)}
            title={chipLabel(c)}
            data-live={live?.pulses.get(c.id)}
            data-arrived={live?.arrived.has(c.id) || undefined}
            data-focus={live?.focus?.taskId === c.id || undefined}
            onClick={(e) => {
              e.stopPropagation();
              live?.onOpenTask?.(c.key);
            }}
            className="flow-chip nodrag nopan flex h-[22px] w-full min-w-0 items-center gap-1.5 rounded-md border bg-background pr-1.5 pl-0.5 text-left text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {c.holder ? (
              <MemberAvatar member={c.holder} working={c.holder.working} className="size-[18px] text-[8px]" />
            ) : (
              <span aria-hidden className="size-[18px] flex-none rounded-full border border-dashed border-muted-foreground/60" />
            )}
            {c.parentKey && <span className="flex-none font-mono text-[10px] text-muted-foreground/80">{c.parentKey} ›</span>}
            <span className="flex-none font-mono text-[11px] font-medium">{c.key}</span>
            <span className="min-w-0 truncate text-muted-foreground">{c.title}</span>
          </button>
        </li>
      ))}
      {more > 0 && (
        <li className="flex h-6 items-center">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenStep?.(step.id);
            }}
            className="nodrag nopan rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            +{more} more
          </button>
        </li>
      )}
    </ul>
  );
}

/**
 * A Step: its name, its Skill (or that it is a hold, drawn dashed), the Members who take its
 * Tasks, and how many Tasks wait at it and are worked. A Step whose Skill no Member of the
 * Project holds says so in amber, as one with a Skill and no Connector out does ("No way out").
 * Live, its Tasks show as chips under its Skill, and it is outlined for a moment when one is
 * picked up there. Editing, "+" on its corner adds a Step after it, clear of the outcomes' names
 * beside its right side.
 */
export function StepNode({ data: { step, deadEnd }, selected }: NodeProps<StepFlowNode>) {
  const { mode, onAdd, opens, onOpenStep, live } = useCanvas();
  const edit = mode === "edit";
  const hold = isHold(step);
  const warn = unstaffed(step);
  const focused = live?.focus?.steps.includes(step.id);
  return (
    <div
      data-glow={live?.glows.get(step.id)}
      className={cn(
        "flow-step group/step relative flex size-full flex-col justify-between rounded-lg border bg-card px-3 pt-2 pb-2.5 text-card-foreground shadow-soft",
        hold && "border-dashed border-muted-foreground/50 bg-muted/40",
        (warn || deadEnd) && "border-warn-border",
        selected && "border-ring ring-2 ring-ring/40",
        focused && "border-foreground/60 ring-2 ring-ring/40",
        opens && "cursor-pointer hover:border-ring/60",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-semibold">{step.name}</span>
        {deadEnd && (
          <span className="ml-auto flex flex-none items-center gap-1 text-xs font-medium text-state-claimed" title={noWayOut}>
            <TriangleAlertIcon aria-hidden className="size-3.5 flex-none" />
            No way out
          </span>
        )}
      </span>
      <span className="truncate text-xs text-muted-foreground">{step.skill ? step.skill.name : "Hold · moved on by hand"}</span>
      {!edit && <Chips step={step} live={live} onOpenStep={onOpenStep} />}
      <span className="flex min-w-0 items-center gap-2">
        {warn ? (
          <span
            className="flex min-w-0 items-center gap-1 text-xs font-medium text-state-claimed"
            title={`No Member of this Project has ${step.skill!.name}: its Tasks wait for nobody`}
          >
            <TriangleAlertIcon aria-hidden className="size-3.5 flex-none" />
            <span className="truncate">No Member has it</span>
          </span>
        ) : (
          <Takers takers={step.takers} live={!edit} />
        )}
        <span
          className="ml-auto flex-none text-xs text-muted-foreground tabular-nums"
          title={step.medianMs !== undefined ? `A Task's median time here: ${spanText(step.medianMs)} (30 days)` : undefined}
        >
          {step.tasks === 0 ? (
            "No Tasks"
          ) : (
            <>
              {waitingAt(step) > 0 && `${waitingAt(step)} waiting`}
              {waitingAt(step) > 0 && step.working > 0 && " · "}
              {step.working > 0 && <span className="text-foreground">{step.working} working</span>}
            </>
          )}
        </span>
      </span>

      <Handle type="target" position={Position.Left} id="in" isConnectable={edit} className="canvas-handle" />
      <Handle type="source" position={Position.Right} id="out" isConnectable={edit} className="canvas-handle" />
      {/* Where a route back leaves and enters (route.ts): never dragged from. */}
      <Handle type="source" position={Position.Left} id="out-left" isConnectable={false} className="canvas-handle-hidden" />
      <Handle type="target" position={Position.Right} id="in-right" isConnectable={false} className="canvas-handle-hidden" />
      <Handle type="target" position={Position.Bottom} id="in-bottom" isConnectable={false} className="canvas-handle-hidden" />
      <Handle type="target" position={Position.Top} id="in-top" isConnectable={false} className="canvas-handle-hidden" />
      {edit && onAdd && (
        <button
          type="button"
          aria-label={`Add a Step after ${step.name}`}
          title="Add a Step after this one"
          onClick={(e) => {
            e.stopPropagation();
            onAdd(step.id);
          }}
          className="nodrag nopan absolute -top-2.5 -right-2.5 grid size-5 place-items-center rounded-full border bg-background text-muted-foreground opacity-0 shadow-soft transition-opacity group-hover/step:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none [.selected_&]:opacity-100"
        >
          <PlusIcon className="size-3" />
        </button>
      )}
    </div>
  );
}

/**
 * Done and Dropped, fixed right of the Steps. A Connector leads into Done; Dropped needs none, so
 * a dashed arrow "from any Step" leads into it, which is Darkory's and cannot be edited.
 */
export function TerminalNode({ data: { terminal } }: NodeProps<TerminalFlowNode>) {
  const { mode } = useCanvas();
  if (terminal === "done") {
    return (
      <div className="flex size-full items-center justify-center gap-1.5 rounded-full border bg-card font-medium text-card-foreground shadow-soft">
        <span aria-hidden className="flex">
          <WorkGlyph glyph={{ glyph: "done" }} />
        </span>
        Done
        <Handle type="target" position={Position.Left} id="in" isConnectable={mode === "edit"} className="canvas-handle" />
      </div>
    );
  }
  return (
    <div className="relative flex size-full items-center justify-center gap-1.5 rounded-full border border-dashed border-muted-foreground/60 font-medium text-muted-foreground">
      <svg aria-hidden className="pointer-events-none absolute top-0 right-full h-full w-[132px] overflow-visible" viewBox="0 0 132 40">
        <text x="4" y="13" className="fill-muted-foreground text-[11px]">
          from any Step
        </text>
        <path d="M 0 20 L 124 20" className="stroke-muted-foreground" strokeWidth={1.25} strokeDasharray="4 4" fill="none" />
        <path d="M 118 15 L 126 20 L 118 25" className="stroke-muted-foreground" strokeWidth={1.25} fill="none" strokeLinejoin="round" />
      </svg>
      <span aria-hidden className="flex">
        <WorkGlyph glyph={{ glyph: "dropped" }} />
      </span>
      Dropped
    </div>
  );
}

/** A Step with a Skill and no Connector out, said where its outcomes are listed. */
export function NoWayOut({ className }: { className?: string }) {
  return (
    <p className={cn("flex items-center gap-1.5 font-medium text-state-claimed", className)}>
      <TriangleAlertIcon aria-hidden className="size-3.5 flex-none" />
      {noWayOut}
    </p>
  );
}
