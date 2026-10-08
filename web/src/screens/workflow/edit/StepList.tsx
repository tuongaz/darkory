import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { GripVerticalIcon, PlusIcon } from "lucide-react";
import { Fragment, useRef, type KeyboardEvent } from "react";
import type { Skill } from "@/api/client";
import { MemberAvatar } from "@/components/MemberAvatar";
import { cn } from "@/lib/utils";
import type { RecordStep, WorkflowRecord } from "../bind";
import type { Holder } from "./holders";
import { isNewSkill, outcomes, type Draft, type Group } from "./draft";
import { InfoTip } from "@/components/InfoTip";
import { Tip } from "@/components/Tip";

/*
 * The Workflow's Steps as text, one 38px row each: its number, name, Skill, who takes it and where
 * its main outcome leads. Picking a row opens the Step in the panel beside the list; nothing here is
 * a field. Between rows a band shows "+ Add Step" on hover, in room it always keeps, and each group
 * ends with "+ Add Step". Rows reorder by their grip, Alt+↑/↓, or the panel's menu; ↑/↓ pick the
 * next row.
 */

export const listGrid = "grid grid-cols-[22px_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1.6fr)] items-center gap-x-2.5";

/** What the list marks under a row: where New Tasks start, the Break down Step, and skill-review's Organisation-wide takers. */
export type RowTags = { start?: string; breakdown?: { start?: string }; orgWide?: boolean };

export function StepList({
  draft,
  base,
  skills,
  holders,
  groups,
  readOnly,
  picked,
  onPick,
  onInsert,
  onReorder,
  onMove,
  tags,
}: {
  draft: Draft;
  base: WorkflowRecord;
  skills: Skill[];
  /** Who takes each Skill's Steps; undefined while unknown. */
  holders?: Map<string, Holder[]>;
  groups: (s: RecordStep) => Group;
  readOnly: boolean;
  picked: string | undefined;
  onPick: (id: string) => void;
  /** Adds a Step after `after` (at the end of `group` when it is undefined). */
  onInsert: (after: string | undefined, group: Group) => void;
  onReorder: (id: string, by: -1 | 1) => void;
  onMove: (id: string, onto: string) => void;
  tags: (s: RecordStep) => RowTags;
}) {
  const wf = draft.wf;
  const order = [...wf.steps].sort((a, b) => a.position - b.position);
  const main = order.filter((s) => groups(s) === "main");
  const after = order.filter((s) => groups(s) === "after");
  const number = new Map([...main, ...after].map((s, i) => [s.id, i + 1]));
  const shown = [...main, ...after];
  const rows = useRef(new Map<string, HTMLButtonElement>());

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const a = wf.steps.find((s) => s.id === active.id);
    const o = wf.steps.find((s) => s.id === over.id);
    if (!a || !o || groups(a) !== groups(o)) return;
    onMove(a.id, o.id);
  };

  const onKey = (s: RecordStep) => (e: KeyboardEvent) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const by = e.key === "ArrowUp" ? -1 : 1;
    if (e.altKey) {
      if (!readOnly) onReorder(s.id, by);
      return;
    }
    const next = shown[shown.findIndex((x) => x.id === s.id) + by];
    if (next) {
      onPick(next.id);
      rows.current.get(next.id)?.focus();
    }
  };

  const skillOf = (id: string | undefined) => (id ? (skills.find((k) => k.id === id)?.name ?? draft.skills[id]?.name) : undefined);
  const nameOf = (id: string | undefined) => (id ? wf.steps.find((s) => s.id === id)?.name.trim() || "New Step" : "Done");

  const row = (s: RecordStep) => (
    <Row
      key={s.id}
      step={s}
      n={number.get(s.id)!}
      fresh={!base.steps.some((b) => b.id === s.id)}
      picked={picked === s.id}
      readOnly={readOnly}
      skillName={skillOf(s.skill_id)}
      pending={isNewSkill(s.skill_id)}
      takers={s.skill_id && !isNewSkill(s.skill_id) && holders ? (holders.get(s.skill_id) ?? []) : undefined}
      out={outcomes(wf, s.id).map((c) => nameOf(c.to_step_id))}
      tags={tags(s)}
      onPick={() => onPick(s.id)}
      onKeyDown={onKey(s)}
      buttonRef={(el) => (el ? rows.current.set(s.id, el) : rows.current.delete(s.id))}
    />
  );

  const group = (steps: RecordStep[], g: Group) => (
    <SortableContext items={steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
      {steps.map((s, i) => (
        <Fragment key={s.id}>
          {row(s)}
          {!readOnly && i < steps.length - 1 && <InsertBand after={s} onInsert={() => onInsert(s.id, g)} />}
        </Fragment>
      ))}
      {!readOnly && (
        <div className="py-1.5 pl-[40px] max-md:pl-4">
          <button
            type="button"
            onClick={() => onInsert(steps.at(-1)?.id, g)}
            aria-label={g === "main" ? "Add a Step at the end of the line" : "Add a Step after a Parent"}
            className={addStepClass}
          >
            <PlusIcon aria-hidden className="size-3" /> Add Step
          </button>
        </div>
      )}
    </SortableContext>
  );

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <div className={cn(listGrid, "px-2 pt-1 pb-1.5 text-xs text-muted-foreground max-md:hidden")} aria-hidden>
        <span />
        <span>Step</span>
        <span>Skill</span>
        <span>Taken by</span>
        <span>Outcomes</span>
      </div>
      <div role="list" aria-label="Steps" className="flex flex-col">
        {group(main, "main")}
        {after.length > 0 && (
          <>
            <div role="presentation" className="flex items-center gap-1 px-2 pt-4 pb-1 max-md:px-4">
              <span className="text-[13px] font-semibold">After a Parent</span>
              <InfoTip label="After a Parent">
                Darkory files Acceptance under a Parent when its Subtasks end, and Retro when it ends; Skill review follows Retro.
              </InfoTip>
            </div>
            {group(after, "after")}
          </>
        )}
      </div>
    </DndContext>
  );
}

export const addStepClass =
  "inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-input bg-background px-2.5 text-xs text-muted-foreground outline-none hover:border-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50";

/**
 * Between two rows: a band that always keeps its room, showing "+ Add Step" on hover or focus. Only
 * its colour changes, so nothing in the list moves. Never over a row.
 */
function InsertBand({ after, onInsert }: { after: RecordStep; onInsert: () => void }) {
  const name = after.name.trim() || "the new Step";
  return (
    <div className="group/gap relative flex h-5 items-center pl-[40px] max-md:hidden">
      <span aria-hidden className="absolute inset-x-[40px] top-1/2 h-px bg-foreground/30 opacity-0 group-focus-within/gap:opacity-100 group-hover/gap:opacity-100" />
      <button
        type="button"
        onClick={onInsert}
        aria-label={`Add a Step after ${name}`}
        className={cn(addStepClass, "relative z-10 h-5 border-ring text-foreground opacity-0 group-focus-within/gap:opacity-100 group-hover/gap:opacity-100")}
      >
        <PlusIcon aria-hidden className="size-3" /> Add Step
      </button>
    </div>
  );
}

function Row({
  step,
  n,
  fresh,
  picked,
  readOnly,
  skillName,
  pending,
  takers,
  out,
  tags,
  onPick,
  onKeyDown,
  buttonRef,
}: {
  step: RecordStep;
  n: number;
  fresh: boolean;
  picked: boolean;
  readOnly: boolean;
  skillName: string | undefined;
  pending: boolean;
  takers: Holder[] | undefined;
  /** Where each outcome leads, the main one first. */
  out: string[];
  tags: RowTags;
  onPick: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: step.id, disabled: readOnly });
  const name = step.name.trim() || "New Step";
  const hold = !step.skill_id;
  const tag = tags.start ? (
    <span className="rounded-full bg-state-waiting-bg px-2 text-[11px] leading-[18px] text-state-waiting">New Tasks start here</span>
  ) : tags.breakdown ? (
    <Chip text="Break down" hint={tags.breakdown.start && `Subtasks start at ${tags.breakdown.start} by default`} className="bg-agent-bg text-agent" />
  ) : tags.orgWide ? (
    <Chip text="Organisation-wide" hint="Taken by anyone in the Organisation with skill-review" className="border text-muted-foreground" />
  ) : null;
  return (
    <div
      ref={setNodeRef}
      role="listitem"
      aria-label={`${n}. ${name}`}
      style={{ transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined, transition }}
      className={cn("group/row relative", isDragging && "z-20 bg-background shadow-soft")}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-current={picked || undefined}
        aria-label={`${n}. ${name}`}
        onClick={onPick}
        onKeyDown={onKeyDown}
        className={cn(
          listGrid,
          "h-[38px] w-full rounded-md px-2 text-left text-[13.5px] outline-none hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "max-md:flex max-md:h-auto max-md:min-h-[52px] max-md:flex-col max-md:items-start max-md:gap-0.5 max-md:rounded-none max-md:border-b max-md:px-4 max-md:py-2",
          picked && "bg-accent ring-1 ring-border hover:bg-accent",
          fresh && "bg-state-claimed-bg hover:bg-state-claimed-bg",
        )}
      >
        <span className="text-right text-xs text-muted-foreground tabular-nums max-md:hidden">{n}</span>
        <span className={cn("truncate font-medium", !step.name.trim() && "text-muted-foreground")}>
          <span className="mr-2 text-xs font-normal text-muted-foreground tabular-nums md:hidden">{n}</span>
          {name}
          {(tags.start || tags.breakdown) && (
            <span className={cn("ml-2 rounded-full px-1.5 text-[11px] font-normal md:hidden", tags.start ? "bg-state-waiting-bg text-state-waiting" : "bg-agent-bg text-agent")}>
              {tags.start ? "Start" : "Break down"}
            </span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-2 max-md:flex-wrap max-md:text-xs max-md:text-muted-foreground md:contents">
          <span className={cn("truncate font-mono text-[11.5px] text-muted-foreground", pending && "text-state-claimed")}>{skillName ?? "Hold"}</span>
          <span className="flex min-w-0 items-center gap-2 overflow-hidden text-[12.5px]">
            {hold ? (
              <span className="text-muted-foreground">by hand</span>
            ) : pending ? (
              <span className="text-muted-foreground">after Save</span>
            ) : !takers ? null : takers.length === 0 ? (
              <span className="font-medium whitespace-nowrap text-state-claimed">Owner takes it</span>
            ) : (
              <>
                <span className="flex flex-none items-center gap-[3px]">
                  {takers.slice(0, 3).map((h) => (
                    <MemberAvatar key={h.id} member={h} card={false} />
                  ))}
                </span>
                <span className="truncate">{takers[0].name}</span>
                {takers.length > 1 && <span className="flex-none text-[11px] text-muted-foreground">+{takers.length - 1}</span>}
              </>
            )}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {out.length > 0 ? (
              <>
                → {out[0]}
                {out.length > 1 && ` · +${out.length - 1}`}
              </>
            ) : hold ? null : (
              <span className="font-medium text-state-claimed">No way out</span>
            )}
          </span>
        </span>
      </button>
      {tag && <div className="-mt-1.5 pb-1 pl-[42px] max-md:hidden">{tag}</div>}
      {!readOnly && (
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          tabIndex={-1}
          aria-label={`Reorder ${name}: drag, or Alt+↑ and Alt+↓`}
          className="absolute top-[11px] left-0 flex h-4 w-3.5 cursor-grab touch-none items-center justify-center rounded-sm text-muted-foreground opacity-0 group-hover/row:opacity-100 max-md:hidden"
        >
          <GripVerticalIcon aria-hidden className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** A chip with its detail on hover or focus, when it has any. */
function Chip({ text, hint, className }: { text: string; hint?: string; className: string }) {
  const chip = <span className={cn("rounded-full px-2 text-[11px] leading-[18px]", className)}>{text}</span>;
  if (!hint) return chip;
  return (
    <Tip label={hint}>
      <span tabIndex={0} aria-label={`${text}: ${hint}`} className="inline-flex rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
        {chip}
      </span>
    </Tip>
  );
}
