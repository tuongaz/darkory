import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { ChevronLeftIcon, ChevronRightIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Tip } from "@/components/Tip";
import { cn } from "@/lib/utils";
import { nameMax } from "../edits";
import type { RecordWorkflow } from "./draft";

/*
 * Above the Step list: the Project's Workflows as a row of segments in their order, the picked one
 * current. An admin adds one (`+ Workflow`, named "Workflow 2", "Workflow 3"… with its name in a
 * field at once), and on the picked one renames it (pencil), moves it left or right (← →, the
 * arrow keys on the segment, or a drag) and deletes it (trash). Nothing moves on hover.
 */

export type RailActions = {
  pick: (id: string) => void;
  /** Adds a Workflow last; its id. */
  add: () => string;
  rename: (id: string, name: string) => void;
  /** Ends a run of typing in a name. */
  settle: () => void;
  reorder: (id: string, by: -1 | 1) => void;
  moveTo: (id: string, onto: string) => void;
  remove: (id: string) => void;
};

export function WorkflowsRail({
  workflows,
  picked,
  readOnly,
  invalid,
  actions,
}: {
  /** In order. */
  workflows: RecordWorkflow[];
  picked: string | undefined;
  readOnly: boolean;
  /** Save was pressed with something to fix: an empty name is marked. */
  invalid: boolean;
  actions?: RailActions;
}) {
  const [renaming, setRenaming] = useState<string | undefined>();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) actions?.moveTo(String(active.id), String(over.id));
  };
  const editable = !readOnly && !!actions;
  const done = () => {
    setRenaming(undefined);
    actions?.settle();
  };

  return (
    <div className="flex min-w-0 items-center gap-2 overflow-x-auto px-3 pt-3 max-md:px-4">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={workflows.map((w) => w.id)} strategy={horizontalListSortingStrategy}>
          <div role="list" aria-label="Workflows" className="inline-flex flex-none items-center gap-0.5 rounded-md bg-muted p-0.5">
            {workflows.map((w, i) => (
              <Segment
                key={w.id}
                workflow={w}
                current={w.id === picked}
                draggable={editable}
                renaming={editable && renaming === w.id}
                invalid={invalid}
                onPick={() => actions?.pick(w.id)}
                onRename={(name) => actions?.rename(w.id, name)}
                onDone={done}
                onKeyDown={(e) => {
                  if (!editable || w.id !== picked || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
                  e.preventDefault();
                  actions!.reorder(w.id, e.key === "ArrowLeft" ? -1 : 1);
                }}
                controls={
                  editable && w.id === picked && renaming !== w.id ? (
                    <Controls
                      name={w.name.trim() || "New Workflow"}
                      first={i === 0}
                      last={i === workflows.length - 1}
                      onRename={() => setRenaming(w.id)}
                      onMove={(by) => actions!.reorder(w.id, by)}
                      onRemove={() => actions!.remove(w.id)}
                    />
                  ) : null
                }
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {editable && (
        <button
          type="button"
          aria-label="Add a Workflow"
          onClick={() => {
            const id = actions!.add();
            actions!.pick(id);
            setRenaming(id);
          }}
          className="inline-flex h-7 flex-none items-center gap-1 rounded-md border border-dashed border-input bg-background px-2.5 text-xs text-muted-foreground outline-none hover:border-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <PlusIcon aria-hidden className="size-3" /> Workflow
        </button>
      )}
    </div>
  );
}

function Segment({
  workflow,
  current,
  draggable,
  renaming,
  invalid,
  onPick,
  onRename,
  onDone,
  onKeyDown,
  controls,
}: {
  workflow: RecordWorkflow;
  current: boolean;
  draggable: boolean;
  renaming: boolean;
  invalid: boolean;
  onPick: () => void;
  onRename: (name: string) => void;
  onDone: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
  controls: ReactNode;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: workflow.id, disabled: !draggable || renaming });
  const name = workflow.name.trim() || "New Workflow";
  return (
    <div
      ref={setNodeRef}
      role="listitem"
      aria-label={name}
      style={{ transform: transform ? `translate3d(${transform.x}px, 0, 0)` : undefined, transition }}
      className={cn("flex flex-none items-center rounded-[6px]", current && "bg-background shadow-soft", isDragging && "z-20")}
    >
      {renaming ? (
        <input
          // A new Workflow's name, or one being renamed, takes the keys at once.
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          value={workflow.name}
          maxLength={nameMax}
          aria-label="Name of the Workflow"
          aria-invalid={(invalid && !workflow.name.trim()) || undefined}
          onChange={(e) => onRename(e.target.value)}
          onBlur={onDone}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") {
              e.preventDefault();
              onDone();
            }
          }}
          className="h-[26px] w-[160px] rounded-[6px] border border-input bg-background px-2 text-[13px] font-medium outline-none focus-visible:border-foreground focus-visible:ring-[3px] focus-visible:ring-muted aria-invalid:border-destructive"
        />
      ) : (
        <button
          type="button"
          aria-current={current || undefined}
          onClick={onPick}
          onKeyDown={onKeyDown}
          {...(draggable ? listeners : {})}
          className={cn(
            "inline-flex h-[26px] max-w-[200px] items-center rounded-[6px] px-2.5 text-[13px] font-medium text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            current ? "text-foreground" : "hover:text-foreground",
            !workflow.name.trim() && "italic",
            invalid && !workflow.name.trim() && "text-destructive",
          )}
        >
          <span className="truncate">{name}</span>
        </button>
      )}
      {controls}
    </div>
  );
}

function Controls({ name, first, last, onRename, onMove, onRemove }: { name: string; first: boolean; last: boolean; onRename: () => void; onMove: (by: -1 | 1) => void; onRemove: () => void }) {
  return (
    <span className="flex items-center pr-0.5">
      <IconButton label={`Rename ${name}`} onClick={onRename}>
        <PencilIcon />
      </IconButton>
      <IconButton label={`Move ${name} left`} disabled={first} onClick={() => onMove(-1)}>
        <ChevronLeftIcon />
      </IconButton>
      <IconButton label={`Move ${name} right`} disabled={last} onClick={() => onMove(1)}>
        <ChevronRightIcon />
      </IconButton>
      <IconButton label={`Delete ${name}`} onClick={onRemove}>
        <Trash2Icon />
      </IconButton>
    </span>
  );
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tip label={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5"
      >
        {children}
      </button>
    </Tip>
  );
}
