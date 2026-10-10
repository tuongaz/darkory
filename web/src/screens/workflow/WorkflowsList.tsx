import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type Announcements, type DragEndEvent, type UniqueIdentifier } from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { GripVerticalIcon, MoreHorizontalIcon, PencilIcon } from "lucide-react";
import { useMemo, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";
import type { Project } from "@/api/client";
import { useTasks } from "@/api/queries";
import { projectPath, workflowEditPath, workflowsPath } from "@/app/currentProject";
import { useNow } from "@/clock";
import { startOf } from "@/components/filters/dates";
import { stepFilterSearch } from "@/components/filters/filterState";
import { shownWorkflow } from "@/components/pickedWorkflow";
import { Refusal } from "@/components/Refusal";
import { Tip } from "@/components/Tip";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { drawnWorkflow, scopedLine, useLineData, WorkflowLine, workflowsInOrder, type LineData, type LineFacts } from "@/components/workflowLine";
import { cn } from "@/lib/utils";
import type { WorkflowRecord } from "./bind";
import type { RecordWorkflow } from "./edit/draft";
import { useFirstMove, useOpenTask } from "./lineMoves";
import type { WorkflowActs } from "./useWorkflowActs";

/** What the list does for an admin: the acts, and the Workflow the delete asks about. */
type Acts = Pick<WorkflowActs, "busy" | "skillMap" | "move"> & {
  onDelete: (w: RecordWorkflow) => void;
};

/**
 * The narrowest a column draws its line in: its rail, a Step's name with its Skill tag, median and
 * takers, and three held chips wrap inside it. The columns are as many as fit the width at this
 * or wider (three at 1184), one on a phone.
 */
const COLUMN = 272;

/** One Workflow's column: its line drawn alone, and its open Tasks and those done today counted where its page lists them. */
type Column = {
  workflow: RecordWorkflow;
  facts: LineFacts;
  scoped: ReturnType<typeof scopedLine>;
  open: number;
  doneToday?: number;
};

/**
 * /projects/:key/workflows (vf-8): each Workflow of the Project as its own line, side by side in
 * columns in their order, stacked on a phone. A column's head names the Workflow (opening its
 * page) and its open Tasks; its line is the Workflow page's own at that width, a Task's chip
 * selecting it there. The Project's line data is read once and each column drawn from it. With
 * `acts` (an admin), each head also orders its Workflow (the grip: dragged, or ← and →; the ⋯),
 * opens its editor and deletes it, the last Workflow staying.
 */
export function WorkflowsList({ project, graph, acts }: { project: Project; graph: WorkflowRecord; acts?: Acts }) {
  const { data, error } = useLineData(project.key, undefined, null);
  const now = useNow();
  // The same read as the line's "N today": what reached Done since midnight.
  const done = useTasks({
    project: project.key,
    state: "done",
    filter: [`completed_at:gte:${startOf(new Date(now))}`],
  }).data;
  const columns = useMemo(() => (data ? columnsOf(graph, data, done) : undefined), [graph, data, done]);
  const [selected, setSelected] = useState<string | null>(null);
  const openTask = useOpenTask();
  const actionFor = useFirstMove(data?.records ?? noRecords);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  if (error) return <Refusal error={error} className="m-6" />;
  if (!data || !columns) return <Skeleton aria-label="Loading the Workflows" className="m-6 h-[420px]" />;

  const ids = columns.map((c) => c.workflow.id);
  // What a drag says to a screen reader, in the Workflows' names; the grip's own name says its keys.
  const nameOf = (id: UniqueIdentifier | undefined) => columns.find((c) => c.workflow.id === id)?.workflow.name ?? "";
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${nameOf(active.id)}`,
    onDragOver: ({ active, over }) => (over && over.id !== active.id ? `${nameOf(active.id)} over ${nameOf(over.id)}` : undefined),
    onDragEnd: ({ active, over }) => (over && over.id !== active.id ? `Moved ${nameOf(active.id)} to ${nameOf(over.id)}'s place` : `${nameOf(active.id)} stays`),
    onDragCancel: ({ active }) => `${nameOf(active.id)} stays`,
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!acts || !over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    acts.move(columns[from].workflow, columns[to].workflow, to < from ? -1 : 1);
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} accessibility={{ screenReaderInstructions: { draggable: "" }, announcements }}>
      <SortableContext items={ids} strategy={rectSortingStrategy}>
        <ul
          aria-label="Workflows"
          className="grid min-w-0 items-start gap-x-6 gap-y-8 px-4 py-4 sm:px-6"
          style={{
            gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${COLUMN}px), 1fr))`,
          }}
        >
          {columns.map((c, i) => (
            <WorkflowColumn
              key={c.workflow.id}
              project={project}
              column={c}
              data={data}
              now={now}
              // The strip stands in the column whose line draws the selected Task.
              selected={selected && c.scoped.drawn.some((t) => t.id === selected) ? selected : null}
              onSelect={setSelected}
              onOpenTask={openTask}
              actionFor={actionFor}
              acts={acts}
              earlier={columns[i - 1]?.workflow}
              later={columns[i + 1]?.workflow}
              last={columns.length < 2}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

/**
 * The columns of the Project's Workflows in their order, each drawn from the one read: its line
 * the Workflow's alone (`drawn`, its Steps, every Connector, so one to or from another is an exit
 * or an entry), its Tasks those at its Steps, and its open Tasks and those done today the ones its
 * page lists (`shownWorkflow`, the server's `workflow_id`). A Project of one draws every Step and
 * lists every Task.
 */
function columnsOf(graph: WorkflowRecord, data: LineData, done: LineData["records"] | undefined): Column[] {
  return workflowsInOrder(graph.workflows).map((workflow) => {
    const drawn = drawnWorkflow(data.facts, workflow.id);
    const facts: LineFacts = {
      workflows: data.facts.workflows,
      steps: data.facts.steps,
      connectors: data.facts.connectors,
      ...(drawn ? { drawn } : {}),
    };
    const shown = drawn ? shownWorkflow(drawn, graph, [...(done ?? []), ...data.records]) : undefined;
    const lists = (t: (typeof data.records)[number]) => !shown || shown.shows(t);
    return {
      workflow,
      facts,
      scoped: scopedLine(data.all, { kind: "all" }, { workflow: facts }),
      open: data.records.filter(lists).length,
      doneToday: done?.filter(lists).length,
    };
  });
}

function WorkflowColumn({
  project,
  column,
  data,
  now,
  selected,
  onSelect,
  onOpenTask,
  actionFor,
  acts,
  earlier,
  later,
  last,
}: {
  project: Project;
  column: Column;
  data: LineData;
  now: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onOpenTask: (key: string) => void;
  actionFor: ReturnType<typeof useFirstMove>;
  acts?: Acts;
  earlier?: RecordWorkflow;
  later?: RecordWorkflow;
  last: boolean;
}) {
  const w = column.workflow;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: w.id, disabled: !acts || acts.busy || !acts.skillMap });
  const s = column.scoped;
  return (
    <li
      ref={setNodeRef}
      aria-label={w.name}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        transition,
      }}
      className={cn("@container/col min-w-0", isDragging && "relative z-20 rounded-md bg-background shadow-soft")}
    >
      {/* The name is never cut: the count wraps under it when both do not fit beside the acts. */}
      <div className="mb-2 flex min-h-7 min-w-0 items-start gap-2.5">
        {acts && (
          <Grip
            name={w.name}
            disabled={acts.busy || !acts.skillMap}
            activator={setActivatorNodeRef}
            drag={{ ...attributes, ...listeners }}
            onMove={(by) => {
              const onto = by < 0 ? earlier : later;
              if (onto) acts.move(w, onto, by);
            }}
          />
        )}
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
          <Link to={workflowsPath(project, w.id)} className="min-w-0 text-[15px] leading-7 font-semibold break-words outline-none hover:underline focus-visible:underline">
            {w.name}
          </Link>
          <span className="text-[13px] leading-5 whitespace-nowrap text-muted-foreground tabular-nums">{openTasks(column.open)}</span>
        </div>
        {acts && <HeadActs project={project} workflow={w} acts={acts} earlier={earlier} later={later} last={last} />}
      </div>
      <WorkflowLine
        label={`${w.name} line`}
        workflow={column.facts}
        tasks={s.drawn}
        all={data.all}
        hidden={s.hidden}
        doneToday={column.doneToday}
        now={now}
        selected={selected}
        onSelect={onSelect}
        onOpenTask={onOpenTask}
        me={data.me}
        actionFor={actionFor}
        stepHref={(stepId) => `${projectPath(project, "tasks")}?${stepFilterSearch(stepId)}`}
      />
    </li>
  );
}

const noRecords: LineData["records"] = [];

const openTasks = (n: number) => (n === 0 ? "no open Tasks" : `${n} ${n === 1 ? "Task" : "Tasks"}`);

/** The grip: dragged onto another column, or ← and → from the keyboard, it moves its Workflow there; one write each. */
function Grip({
  name,
  disabled,
  activator,
  drag,
  onMove,
}: {
  name: string;
  disabled: boolean;
  activator: (el: HTMLElement | null) => void;
  drag: Record<string, unknown>;
  onMove: (by: -1 | 1) => void;
}) {
  const onKeyDown = (e: KeyboardEvent) => {
    const by = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : 0;
    if (!by) return;
    e.preventDefault();
    if (!disabled) onMove(by);
  };
  return (
    <Tip label="Drag to order">
      <button
        type="button"
        ref={activator}
        {...drag}
        // Not dnd-kit's own role, keys or instructions: ← and → move it, one write each, as its name says.
        role={undefined}
        aria-describedby={undefined}
        aria-roledescription={undefined}
        aria-label={`Drag to order ${name}, or ← and →`}
        // Off while a write is on its way, it keeps the focus: a moved column's grip stays where the keys left it.
        aria-disabled={disabled || undefined}
        onKeyDown={onKeyDown}
        className="-ml-1 flex h-7 w-4 flex-none cursor-grab touch-none items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-disabled:cursor-default aria-disabled:opacity-40"
      >
        <GripVerticalIcon aria-hidden className="size-3.5" />
      </button>
    </Tip>
  );
}

/** A column's acts, at its head's right: Edit, then the ⋯ with Move earlier, Move later and Delete (the last Workflow stays). */
function HeadActs({ project, workflow: w, acts, earlier, later, last }: { project: Project; workflow: RecordWorkflow; acts: Acts; earlier?: RecordWorkflow; later?: RecordWorkflow; last: boolean }) {
  const ordering = acts.busy || !acts.skillMap;
  // Why the delete is off, said on the item: the last Workflow stays; a write is on its way.
  const keep = last ? "The last Workflow stays" : acts.busy ? "Saving…" : undefined;
  return (
    <span className="ml-auto flex h-7 flex-none items-center gap-1.5">
      <Button asChild variant="outline" size="xs">
        <Link to={workflowEditPath(project, w.id)} aria-label={`Edit ${w.name}`}>
          <PencilIcon aria-hidden />
          Edit
        </Link>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon-xs" aria-label={`More for ${w.name}`}>
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={ordering || !earlier} onSelect={() => earlier && acts.move(w, earlier, -1)}>
            Move earlier
          </DropdownMenuItem>
          <DropdownMenuItem disabled={ordering || !later} onSelect={() => later && acts.move(w, later, 1)}>
            Move later
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" disabled={!!keep} onSelect={() => acts.onDelete(w)}>
            Delete
            {keep && <span className="ml-auto pl-3 text-xs font-normal text-muted-foreground">{keep}</span>}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
