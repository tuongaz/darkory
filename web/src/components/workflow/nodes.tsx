import { Handle, Position, type NodeProps } from "@xyflow/react";
import { PlusIcon, TriangleAlertIcon } from "lucide-react";
import { MemberAvatar } from "@/components/MemberAvatar";
import { WorkGlyph } from "@/components/WorkGlyph";
import { cn } from "@/lib/utils";
import { useCanvas } from "./context";
import type { StepFlowNode, TerminalFlowNode } from "./flow";
import { durationText, isHold, unstaffed, waitingAt, type Taker } from "./model";

const shownTakers = 4;

/** The Members holding a step's Skill, overlapping; past four, "+N" naming the rest on hover. */
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

/**
 * A step: its name, its Skill (or that it is a hold, drawn dashed), the Members who take its
 * Tasks, and how many Tasks wait at it and are worked. A step whose Skill no Member of the
 * Project holds says so in amber. Editing, "+" on its corner adds a step after it, clear of the
 * outcomes' names beside its right side.
 */
export function StepNode({ data: { step }, selected }: NodeProps<StepFlowNode>) {
  const { mode, onAdd } = useCanvas();
  const edit = mode === "edit";
  const hold = isHold(step);
  const warn = unstaffed(step);
  return (
    <div
      className={cn(
        "group/step relative flex size-full flex-col justify-between rounded-lg border bg-card px-3 pt-2 pb-2.5 text-card-foreground shadow-soft",
        hold && "border-dashed border-muted-foreground/50 bg-muted/40",
        warn && "border-warn-border",
        selected && "border-ring ring-2 ring-ring/40",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-semibold">{step.name}</span>
      </span>
      <span className="truncate text-xs text-muted-foreground">{step.skill ? step.skill.name : "Hold · moved on by hand"}</span>
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
          title={step.medianMs !== undefined ? `A Task's median time here: ${durationText(step.medianMs)} (30 days)` : undefined}
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
          aria-label={`Add a step after ${step.name}`}
          title="Add a step after this one"
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
 * Done and Dropped, fixed right of the steps. A Connector leads into Done; Dropped needs none, so
 * a dashed arrow "from any step" leads into it, which is Darkory's and cannot be edited.
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
          from any step
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
