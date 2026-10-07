// F-B1 and F-B4: a Team's Tasks as a kanban, one column per Status. Dragging a card between
// columns sets its Status; Done and Dropped refuse it, and the card snaps back.
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
import { MemberAvatar } from "@/components/MemberAvatar";
import { StatusGlyph } from "@/components/StatusGlyph";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { liveClaim } from "@/work";
import { AimedAt, BlocksPill, FeatureRef, HeartbeatLine, MarkPill, SkillPill } from "./bits";
import { isOpenKind, marksOf, type Status } from "./derive";
import { aimedAt, featureOf, holderOf, type BoardModel } from "./model";

export type Column = { status: Status; tasks: Task[]; collapsed: boolean };

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
  onMove,
  onExpand,
  onAdd,
}: {
  model: BoardModel;
  columns: Column[];
  onMove: (task: Task, to: Status) => void;
  onExpand: (status: Status) => void;
  onAdd: (status: Status) => void;
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
  const [active, setActive] = useState<Task | null>(null);
  const [over, setOver] = useState<Status | null>(null);
  const byId = new Map(columns.flatMap((c) => c.tasks).map((t) => [t.id, t]));
  const statusOf = (id: unknown) => model.statusById.get(String(id));

  const start = (e: DragStartEvent) => setActive(byId.get(String(e.active.id)) ?? null);
  const move = (e: DragOverEvent) => setOver(e.over ? (statusOf(e.over.id) ?? null) : null);
  const end = (e: DragEndEvent) => {
    const task = byId.get(String(e.active.id));
    const to = e.over ? statusOf(e.over.id) : undefined;
    setActive(null);
    setOver(null);
    if (task && to && to.id !== task.status_id) onMove(task, to);
  };
  const cancel = () => {
    setActive(null);
    setOver(null);
  };
  // A move between open kinds lands where it was dropped; a drop on Done or Dropped returns home.
  const landsInPlace = !!over && !!active && isOpenKind(over.kind) && over.id !== active.status_id;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={start}
      onDragOver={move}
      onDragEnd={end}
      onDragCancel={cancel}
      accessibility={{
        screenReaderInstructions: { draggable: "Press Space to pick up the card, Left and Right to move it between Statuses, Space to drop it, Escape to cancel." },
        announcements: {
          onDragStart: ({ active }) => `Picked up ${byId.get(String(active.id))?.key ?? "a Task"}.`,
          onDragOver: ({ over }) => (over ? `Over ${statusOf(over.id)?.name ?? "a Status"}.` : "Not over a Status."),
          onDragEnd: ({ active, over }) => `Dropped ${byId.get(String(active.id))?.key ?? "the Task"}${over ? ` on ${statusOf(over.id)?.name}` : ""}.`,
          onDragCancel: ({ active }) => `${byId.get(String(active.id))?.key ?? "The Task"} stays where it was.`,
        },
      }}
    >
      {/* While a card is carried the keys are the drag's, not the shell's (J, K, the arrows). */}
      <div className="flex min-h-full w-max items-stretch gap-3 p-4" data-dragging={active ? "" : undefined}>
        {columns.map((c) => (
          <BoardColumn
            key={c.status.id}
            column={c}
            model={model}
            // Done and Dropped refuse a drop (Complete and Drop reach them), so they never invite one.
            dropTarget={!!active && isOpenKind(c.status.kind) && over?.id === c.status.id && c.status.id !== active.status_id}
            onExpand={onExpand}
            onAdd={onAdd}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={landsInPlace ? null : undefined}>
        {active && <CardBody task={active} model={model} lifted />}
      </DragOverlay>
    </DndContext>
  );
}

function BoardColumn({
  column: { status, tasks, collapsed },
  model,
  dropTarget,
  onExpand,
  onAdd,
}: {
  column: Column;
  model: BoardModel;
  dropTarget: boolean;
  onExpand: (status: Status) => void;
  onAdd: (status: Status) => void;
}) {
  const { setNodeRef } = useDroppable({ id: status.id });
  const glyph = <StatusGlyph glyph={model.glyphs.get(status.id) ?? "todo"} label={status.name} />;
  const outline = dropTarget && "rounded-md outline-2 outline-offset-4 outline-ring outline-dashed";
  if (collapsed) {
    // A hidden column keeps only its header, glyph and name on one line as every column's are, so
    // the glyph reads as the Status's and not as a close button; a click shows the column.
    return (
      <section ref={setNodeRef} aria-label={status.name} data-status={status.name} className={cn("flex flex-none flex-col", outline)}>
        <button
          type="button"
          onClick={() => onExpand(status)}
          aria-label={`Show ${status.name}, ${tasks.length}`}
          title={`Show ${status.name}`}
          className="flex h-7 items-center gap-2 rounded-md px-1.5 font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {glyph}
          {status.name}
          <span className="font-normal tabular-nums">{tasks.length}</span>
          <ChevronRightIcon className="size-3.5" aria-hidden />
        </button>
      </section>
    );
  }
  const open = isOpenKind(status.kind);
  return (
    <section ref={setNodeRef} aria-label={status.name} data-status={status.name} className={cn("flex w-[212px] flex-none flex-col gap-2", outline)}>
      <div className="flex h-7 items-center gap-2 px-1 font-medium">
        {glyph}
        <h2>{status.name}</h2>
        <span className="font-normal text-muted-foreground tabular-nums">{tasks.length}</span>
        {/* Done and Dropped are reached by Complete and Drop, so nothing is filed into them. */}
        {open && (
          <Button variant="ghost" size="icon-xs" className="ml-auto text-muted-foreground" aria-label={`File a Task in ${status.name}`} onClick={() => onAdd(status)}>
            <PlusIcon />
          </Button>
        )}
      </div>
      {tasks.map((t) => (
        <TaskCard key={t.id} task={t} model={model} />
      ))}
    </section>
  );
}

function TaskCard({ task, model }: { task: Task; model: BoardModel }) {
  const peek = usePeekLink();
  // The keys' ring: the card walked to, or the one whose peek is open.
  const selected = useSelectedTask() === task.key;
  // A Member of the Team, the Feature's owner or the holder moves an open Task; an ended one stays.
  const movable = model.canMove(task);
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

function CardBody({ task, model, lifted }: { task: Task; model: BoardModel; lifted?: boolean }) {
  const ended = task.state !== "open";
  const [mark] = marksOf(task, model.trails.get(task.id), model.now);
  const holder = holderOf(task, model);
  const aimed = aimedAt(task, model);
  const blocks = model.blocks.get(task.id) ?? [];
  const needs = ended
    ? null
    : task.skill_id
      ? model.skills.has(task.skill_id) && <SkillPill task={task} model={model} />
      : blocks.length > 0 && <BlocksPill blocks={blocks} />;
  const held = !!liveClaim(task, model.now)?.expires_at;
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-md border bg-card px-2.5 pt-2.5 pb-2 text-card-foreground hover:border-ring",
        lifted ? "rotate-[1.5deg] shadow-pop" : "shadow-soft",
      )}
    >
      {/* The pills row: the key, then the mark, what an open Task needs (a question: what it holds
          up) and who holds it, wrapping to the right under the mark when a card is too narrow. */}
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-1.5 gap-y-1">
        <Key className="mr-auto">{task.key}</Key>
        {mark && <MarkPill mark={mark} now={model.now} />}
        {needs}
        {holder ? <MemberAvatar member={holder} /> : aimed && <AimedAt member={aimed} />}
      </div>
      <div className="leading-[1.35] font-medium">{task.title}</div>
      {/* The Feature on a line of its own, so two clients' Features read apart at five columns. */}
      <FeatureRef feature={featureOf(model, task)} />
      {held && (
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <HeartbeatLine task={task} now={model.now} />
        </div>
      )}
    </div>
  );
}
