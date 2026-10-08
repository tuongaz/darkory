// A Project's Tasks as a kanban: a column per Step in the Workflow's order (a hold's drawn
// dashed), a column per Member Tasks are aimed at, then Done and Dropped. Dragging a card onto a
// Step moves it there by hand; anything `/v1` would refuse is said in words and the card returns.
// On a phone one column shows at a time, picked from a list.
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  rectIntersection,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import type { Task } from "@/api/client";
import { usePeekLink } from "@/app/peek";
import { useSelectedTask } from "@/app/selection";
import { Key } from "@/components/Key";
import { LabelPills } from "@/components/LabelPill";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Pill } from "@/components/Pill";
import { WorkGlyph } from "@/components/WorkGlyph";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { liveClaim } from "@/work";
import { BlocksPill, EvidenceCount, HeartbeatLine, MarkPill, ParentRef, People } from "./bits";
import { columnName, isParent, marksOf, progressText, type Column } from "./derive";
import { aimedAt, holderOf, type TasksModel } from "./model";

// The pointer's column first; with the keyboard, whichever column the card overlaps.
const collision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length > 0 ? within : rectIntersection(args);
};

// With the keyboard, Left and Right move the card a whole column; Space drops it, Escape cancels.
const columnJump: KeyboardCoordinateGetter = (event, { context, currentCoordinates }) => {
  const dir = event.code === "ArrowRight" ? 1 : event.code === "ArrowLeft" ? -1 : 0;
  if (dir === 0) return undefined;
  event.preventDefault();
  const lefts = [...context.droppableRects.values()].map((r) => r.left).sort((a, b) => a - b);
  const x = currentCoordinates.x;
  const next = dir > 0 ? lefts.find((l) => l > x + 8) : lefts.reverse().find((l) => l < x - 8);
  return next === undefined ? undefined : { x: next, y: currentCoordinates.y };
};

export function TaskBoard({
  model,
  columns,
  onDrop,
  onExpand,
  onAdd,
}: {
  model: TasksModel;
  columns: Column[];
  /** A card let go over another column than its own. */
  onDrop: (task: Task, to: Column) => void;
  onExpand: (column: Column) => void;
  onAdd: (stepId: string) => void;
}) {
  const sensors = useSensors(
    // A press that moves less than 5px is a click, which opens the Task. On a touch screen a card
    // is picked up by holding it, so a swipe still scrolls the board.
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: columnJump,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  );
  const phone = useIsMobile();
  const [shown, setShown] = useState<string | undefined>();
  const [active, setActive] = useState<Task | null>(null);
  const [over, setOver] = useState<Column | null>(null);
  const byId = new Map(columns.flatMap((c) => c.tasks).map((t) => [t.id, t]));
  const columnOf = (id: unknown) => columns.find((c) => c.id === String(id));
  const home = (t: Task) => columns.find((c) => c.tasks.some((x) => x.id === t.id));

  const start = (e: DragStartEvent) => setActive(byId.get(String(e.active.id)) ?? null);
  const move = (e: DragOverEvent) => setOver(e.over ? (columnOf(e.over.id) ?? null) : null);
  const end = (e: DragEndEvent) => {
    const task = byId.get(String(e.active.id));
    const to = e.over ? columnOf(e.over.id) : undefined;
    setActive(null);
    setOver(null);
    if (task && to && to.id !== home(task)?.id) onDrop(task, to);
  };
  const cancel = () => {
    setActive(null);
    setOver(null);
  };
  // A card dropped on a Step lands where it was dropped; anywhere else it returns home.
  const landsInPlace = !!over && !!active && over.kind === "step" && over.id !== home(active)?.id;

  // On a phone, one column: the one picked, else the first with a card, else the first.
  const current = phone ? (columns.find((c) => c.id === shown) ?? columns.find((c) => c.tasks.length > 0) ?? columns[0]) : undefined;
  const drawn = current ? [{ ...current, collapsed: false } as Column] : columns;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={start}
      onDragOver={move}
      onDragEnd={end}
      onDragCancel={cancel}
      accessibility={{
        screenReaderInstructions: { draggable: "Press Space to pick up the card, Left and Right to move it between Steps, Space to drop it, Escape to cancel." },
        announcements: {
          onDragStart: ({ active }) => `Picked up ${byId.get(String(active.id))?.key ?? "a Task"}.`,
          onDragOver: ({ over }) => (over ? `Over ${columnName(columnOf(over.id)!, model)}.` : "Not over a column."),
          onDragEnd: ({ active, over }) => `Dropped ${byId.get(String(active.id))?.key ?? "the Task"}${over ? ` on ${columnName(columnOf(over.id)!, model)}` : ""}.`,
          onDragCancel: ({ active }) => `${byId.get(String(active.id))?.key ?? "The Task"} stays where it was.`,
        },
      }}
    >
      {current && (
        <div className="sticky left-0 flex items-center gap-2 px-4 pt-3">
          <Select value={current.id} onValueChange={setShown}>
            <SelectTrigger className="w-full" aria-label="Column">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {columns.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {columnName(c, model)}
                  <span className="text-muted-foreground tabular-nums">{c.tasks.length}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {/* While a card is carried the keys are the drag's, not the shell's (J, K, the arrows). */}
      <div className={cn("flex min-h-full items-stretch gap-3 p-4", phone ? "w-full" : "w-max")} data-dragging={active ? "" : undefined}>
        {drawn.map((c) => (
          <BoardColumn
            key={c.id}
            column={c}
            model={model}
            wide={phone}
            dropTarget={!!active && c.kind === "step" && over?.id === c.id && c.id !== home(active)?.id}
            onExpand={onExpand}
            onAdd={onAdd}
          />
        ))}
      </div>
      <DragOverlay className="card-overlay" dropAnimation={landsInPlace ? null : undefined}>{active && <CardBody task={active} model={model} lifted />}</DragOverlay>
    </DndContext>
  );
}

function ColumnHead({ column: c, model }: { column: Column; model: TasksModel }) {
  if (c.kind === "step") {
    const skill = c.step.skill_id ? model.skills.get(c.step.skill_id) : undefined;
    return (
      <>
        <WorkGlyph glyph={{ glyph: skill ? "waiting" : "hold" }} label={skill ? c.step.name : `${c.step.name}, a hold`} />
        {/* Short of room, the Skill gives way before the Step's name. */}
        <h2 className="max-w-[75%] flex-none truncate">{c.step.name}</h2>
        {skill && <span className="min-w-0 truncate text-xs font-normal text-muted-foreground">{skill.name}</span>}
      </>
    );
  }
  if (c.kind === "with") {
    const m = c.member ?? model.members.get(c.memberId);
    return (
      <>
        {m && <MemberAvatar member={m} />}
        <h2 className="truncate">{columnName(c, model)}</h2>
      </>
    );
  }
  return (
    <>
      <WorkGlyph glyph={{ glyph: c.kind }} />
      <h2>{columnName(c, model)}</h2>
    </>
  );
}

function BoardColumn({
  column: c,
  model,
  wide,
  dropTarget,
  onExpand,
  onAdd,
}: {
  column: Column;
  model: TasksModel;
  wide: boolean;
  dropTarget: boolean;
  onExpand: (column: Column) => void;
  onAdd: (stepId: string) => void;
}) {
  const { setNodeRef } = useDroppable({ id: c.id });
  const name = columnName(c, model);
  const hold = c.kind === "step" && !c.step.skill_id;
  const outline = dropTarget && "rounded-md outline-2 outline-offset-4 outline-ring outline-dashed";
  if ((c.kind === "done" || c.kind === "dropped") && c.collapsed) {
    // A folded column keeps only its header on one line, as every column's is; a click shows it.
    return (
      <section ref={setNodeRef} aria-label={name} data-column={name} className={cn("flex flex-none flex-col", outline)}>
        <button
          type="button"
          onClick={() => onExpand(c)}
          aria-label={`Show ${name}, ${c.tasks.length}`}
          title={`Show ${name}`}
          className="flex h-7 items-center gap-2 rounded-md px-1.5 font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <WorkGlyph glyph={{ glyph: c.kind }} />
          {name}
          <span className="font-normal tabular-nums">{c.tasks.length}</span>
          <ChevronRightIcon className="size-3.5" aria-hidden />
        </button>
      </section>
    );
  }
  return (
    <section
      ref={setNodeRef}
      aria-label={name}
      data-column={name}
      data-hold={hold || undefined}
      className={cn(
        // Every column keeps the same inset, so the headers line up; a hold's edge is drawn dashed.
        "flex flex-none flex-col gap-2 rounded-lg border border-transparent p-1.5",
        wide ? "w-full" : "w-[244px]",
        hold && "border-dashed border-border",
        c.kind === "with" && "bg-muted/40",
        outline,
      )}
    >
      <div className="flex h-7 min-w-0 items-center gap-2 px-1 font-medium">
        <ColumnHead column={c} model={model} />
        <span className="font-normal text-muted-foreground tabular-nums">{c.tasks.length}</span>
        {c.kind === "step" && (
          <Button variant="ghost" size="icon-xs" className="ml-auto text-muted-foreground" aria-label={`File a Task at ${c.step.name}`} onClick={() => onAdd(c.step.id)}>
            <PlusIcon />
          </Button>
        )}
      </div>
      {c.tasks.map((t) => (
        <TaskCard key={t.id} task={t} model={model} />
      ))}
    </section>
  );
}

function TaskCard({ task, model }: { task: Task; model: TasksModel }) {
  const peek = usePeekLink();
  // The keys' ring: the card walked to, or the one whose peek is open.
  const selected = useSelectedTask() === task.key;
  // An open Task that is not a Parent can be carried; where it may go is said on the drop.
  const movable = task.state === "open" && !isParent(task);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id, disabled: !movable });
  // The card stays a link to the Task; the drag adds its description, not a button role.
  const dragAttributes = { ...attributes, role: undefined };
  return (
    <Link
      ref={setNodeRef}
      to={peek(task.key)}
      aria-label={`${task.key} ${task.title}`}
      data-task={task.key}
      data-movable={movable}
      data-selected={selected || undefined}
      {...(movable ? { ...dragAttributes, ...listeners } : {})}
      className={cn(
        "block rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        selected && "ring-2 ring-ring",
        movable && "touch-manipulation",
        isDragging && "opacity-40",
      )}
    >
      <CardBody task={task} model={model} />
    </Link>
  );
}

function CardBody({ task, model, lifted }: { task: Task; model: TasksModel; lifted?: boolean }) {
  const ended = task.state !== "open";
  const trail = model.trails.get(task.id);
  const [mark] = marksOf(task, trail, model.now);
  const holder = holderOf(task, model);
  const aimed = aimedAt(task, model);
  const blocks = model.blocks.get(task.id) ?? [];
  const parent = task.parent_id ? model.byId.get(task.parent_id) : undefined;
  const held = !!liveClaim(task, model.now)?.expires_at;
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-md border bg-card px-2.5 pt-2.5 pb-2 text-card-foreground hover:border-ring",
        lifted ? "rotate-[1.5deg] shadow-pop" : "shadow-soft",
        isParent(task) && "border-dashed",
      )}
    >
      {/* The glyph and key, then the mark, what a question holds up and who it is with. */}
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-1.5 gap-y-1">
        <span className="mr-auto flex items-center gap-1.5">
          <WorkGlyph glyph={model.glyph(task)} />
          <Key>{task.key}</Key>
        </span>
        {mark && <MarkPill mark={mark} now={model.now} />}
        {!ended && task.aimed_at_id && <BlocksPill blocks={blocks} />}
        {task.subtask_counts && <Pill tone="secondary">{progressText(task.subtask_counts)}</Pill>}
        <People holder={holder} aimed={aimed} owner={undefined} />
      </div>
      <div className="leading-[1.35] font-medium">{task.title}</div>
      {parent && <ParentRef parent={parent} />}
      {((task.labels?.length ?? 0) > 0 || (trail?.evidence ?? 0) > 0) && (
        <div className="flex min-w-0 items-center gap-1.5">
          <LabelPills ids={task.labels} labels={model.labelById} />
          <span className="ml-auto">
            <EvidenceCount count={trail?.evidence ?? 0} />
          </span>
        </div>
      )}
      {held && (
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <HeartbeatLine task={task} now={model.now} />
        </div>
      )}
    </div>
  );
}
