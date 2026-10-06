import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GripVerticalIcon, PlusIcon } from "lucide-react";
import { Fragment, useState } from "react";
import { ApiError } from "@/api/client";
import type { components } from "@/api/schema.gen";
import { InfoPopover } from "@/components/InfoPopover";
import { Loaded, Refusal } from "@/components/Refusal";
import { StatusGlyph } from "@/components/StatusGlyph";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { glyphFor, type StatusKind } from "@/lib/status";
import { cn } from "@/lib/utils";
import { AdminFrame } from "./AdminLayout";
import { count } from "./model";
import { Choice, ConfirmDialog, Fact, Facts, MoreMenu } from "./parts";
import { statusesKey, useStatuses, useTasksByStatus } from "./queries";
import { insertAt, kindNames, kinds, moveTargets, problem, rowsOf, setStatusesBody, unchanged, type Problem, type Row } from "./workflow";
import { setStatuses } from "./writes";

type Status = components["schemas"]["Status"];

// Grip · glyph · name · Tasks · kind · ⋯ (F-D6). A phone drops the Tasks column.
const cols = "grid-cols-[16px_14px_minmax(0,1fr)_132px_26px] sm:grid-cols-[16px_14px_220px_72px_168px_minmax(0,1fr)_26px]";

/** /admin/workflow (F-D6): the Organisation's Statuses, in board order. */
export function WorkflowPage() {
  const statuses = useStatuses();
  const [adding, setAdding] = useState(false);
  return (
    <AdminFrame
      crumbs={[{ label: "Workflow" }]}
      primary={
        <Button onClick={() => setAdding(true)} disabled={!statuses.data}>
          <PlusIcon />
          Add Status
        </Button>
      }
    >
      <div className="max-w-[960px]">
        <div className="mb-3 flex items-center gap-2">
          <h1 className="text-xl leading-tight font-semibold tracking-[-0.01em]">Statuses</h1>
          <span className="text-muted-foreground tabular-nums">{statuses.data?.length}</span>
        </div>
        <Loaded query={statuses}>
          {(list) => <StatusEditor current={list} adding={adding} onAdded={() => setAdding(false)} />}
        </Loaded>
      </div>
    </AdminFrame>
  );
}

type Save = { rows: Row[]; moves?: Record<string, string> };

/**
 * The list being edited. Every change sends the whole list as one `PUT /v1/statuses`: a rename
 * when its field is left, a kind when chosen, an order when dropped, a delete when confirmed. What
 * /v1 would refuse is said in words before sending.
 */
function StatusEditor({ current, adding, onAdded }: { current: Status[]; adding: boolean; onAdded: () => void }) {
  const qc = useQueryClient();
  const { counts, tasks } = useTasksByStatus();
  const [refused, setRefused] = useState<Problem | undefined>();
  const [deleting, setDeleting] = useState<Status | null>(null);
  const save = useMutation({
    mutationFn: ({ rows, moves }: Save) => setStatuses(setStatusesBody(rows, moves)),
    onSuccess: (r) => qc.setQueryData(statusesKey, r.items),
  });

  // While a change is on its way, the list shows it; a refusal puts the saved list back.
  const rows = save.isPending ? save.variables.rows : rowsOf(current);

  const commit = (next: Row[], moves?: Record<string, string>, onSaved?: () => void): boolean => {
    const p = problem(next, current, counts, moves);
    setRefused(p);
    if (p) return false;
    save.reset();
    if (unchanged(next, current)) return true;
    save.mutate({ rows: next, moves }, { onSuccess: onSaved });
    return true;
  };

  const nth = (i: number) => rows.slice(0, i).filter((r) => r.kind === rows[i].kind).length;
  const draftAt = insertAt(rows);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = rows.findIndex((r) => r.key === active.id);
    const to = rows.findIndex((r) => r.key === over.id);
    commit(arrayMove(rows, from, to));
  };
  const counted = (r: Row) => (r.id && tasks.data ? (counts.get(r.id) ?? 0) : undefined);

  return (
    <>
      <div role="table" aria-label="Statuses" className="min-w-0">
        <div role="row" className={cn("grid h-8 items-center gap-3 rounded-t-md border-b bg-muted px-2 text-xs font-medium text-muted-foreground", cols)}>
          <span role="columnheader">
            <span className="sr-only">Order</span>
          </span>
          <span role="columnheader">
            <span className="sr-only">Glyph</span>
          </span>
          <span role="columnheader">Name</span>
          <span role="columnheader" className="hidden sm:block">
            Tasks
          </span>
          <span role="columnheader" className="flex items-center gap-1">
            Kind
            <InfoPopover label="About the kinds">
              <p className="mb-1.5 font-semibold">Kinds</p>
              <dl className="grid grid-cols-[76px_minmax(0,1fr)] gap-x-2 gap-y-1 whitespace-nowrap">
                <dt className="text-muted-foreground">Backlog</dt>
                <dd>
                  Not offered by <code>next</code>
                </dd>
                <dt className="text-muted-foreground">Todo</dt>
                <dd>
                  Offered by <code>next</code> when Takeable
                </dd>
                <dt className="text-muted-foreground">In progress</dt>
                <dd>
                  Offered by <code>next</code> when Takeable
                </dd>
                <dt className="text-muted-foreground">Done</dt>
                <dd>Reached by Complete only</dd>
                <dt className="text-muted-foreground">Dropped</dt>
                <dd>Reached by Drop only</dd>
              </dl>
            </InfoPopover>
          </span>
          <span className="hidden sm:block" />
          <span role="columnheader">
            <span className="sr-only">Actions</span>
          </span>
        </div>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={rows.map((r) => r.key)} strategy={verticalListSortingStrategy}>
            {rows.map((r, i) => (
              <Fragment key={r.key}>
                {adding && i === draftAt && <DraftRow rows={rows} at={draftAt} commit={commit} onDone={onAdded} />}
                <StatusRow
                  row={r}
                  nth={nth(i)}
                  tasks={counted(r)}
                  busy={save.isPending}
                  onRename={(name) => commit(rows.map((x) => (x.key === r.key ? { ...x, name } : x)))}
                  onKind={(kind) => commit(rows.map((x) => (x.key === r.key ? { ...x, kind } : x)))}
                  onDelete={() => {
                    setRefused(undefined);
                    setDeleting(current.find((s) => s.id === r.id) ?? null);
                  }}
                />
              </Fragment>
            ))}
            {adding && draftAt === rows.length && <DraftRow rows={rows} at={draftAt} commit={commit} onDone={onAdded} />}
          </SortableContext>
        </DndContext>
      </div>
      {(refused || save.error) && !deleting && (
        <div className="mt-3 flex flex-col gap-1">
          {refused && <Refusal error={new ApiError(0, refused.code, refused.message)} />}
          <Refusal error={save.error} />
        </div>
      )}
      {deleting && (
        <DeleteStatusDialog
          status={deleting}
          rows={rows}
          current={current}
          counts={counts}
          pending={save.isPending}
          error={save.error}
          onDelete={(next, moves) => commit(next, moves, () => setDeleting(null))}
          onClose={() => {
            setDeleting(null);
            save.reset();
          }}
        />
      )}
    </>
  );
}

function StatusRow({
  row,
  nth,
  tasks,
  busy,
  onRename,
  onKind,
  onDelete,
}: {
  row: Row;
  nth: number;
  tasks?: number;
  busy: boolean;
  onRename: (name: string) => void;
  onKind: (kind: StatusKind) => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.key, disabled: !row.id || busy });
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(row.name);
  return (
    <div
      ref={setNodeRef}
      role="row"
      aria-label={row.name}
      style={{ transform: transform ? `translate3d(0, ${Math.round(transform.y)}px, 0)` : undefined, transition }}
      className={cn("relative grid h-11 items-center gap-3 border-b bg-background px-2", cols, isDragging && "z-10 shadow-pop")}
    >
      <span role="cell">
        <button
          type="button"
          aria-label={`Move ${row.name}`}
          className="grid h-6 w-4 cursor-grab touch-none place-items-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVerticalIcon className="size-3.5" />
        </button>
      </span>
      <span role="cell" className="flex">
        <StatusGlyph glyph={glyphFor(row.kind, nth)} />
      </span>
      <span role="cell" className="min-w-0">
        {editing ? (
          <Input
            aria-label={`Name of ${row.name}`}
            autoFocus
            maxLength={50}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => {
              setEditing(false);
              if (name.trim() !== row.name) onRename(name.trim());
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                setName(row.name);
                setEditing(false);
              }
            }}
            className="h-7 w-full sm:w-[220px]"
          />
        ) : (
          <button
            type="button"
            aria-label={`Rename ${row.name}`}
            onClick={() => {
              setName(row.name);
              setEditing(true);
            }}
            className="max-w-full cursor-text truncate rounded-sm px-1 py-0.5 text-left font-medium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {row.name}
          </button>
        )}
      </span>
      <span role="cell" className="hidden text-muted-foreground tabular-nums sm:block">
        {tasks === undefined ? row.id ? <Skeleton className="h-4 w-12" /> : null : count(tasks, "Task")}
      </span>
      <span role="cell">
        <KindSelect label={`Kind of ${row.name}`} value={row.kind} onChange={onKind} disabled={busy} />
      </span>
      <span className="hidden sm:block" />
      <span role="cell">
        <MoreMenu label={`More for ${row.name}`} size="icon-xs">
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            Delete
          </DropdownMenuItem>
        </MoreMenu>
      </span>
    </div>
  );
}

function KindSelect({ label, value, onChange, disabled }: { label: string; value: StatusKind; onChange: (k: StatusKind) => void; disabled?: boolean }) {
  return (
    <Choice
      label={label}
      className="w-full sm:w-[168px]"
      value={value}
      onChange={onChange}
      disabled={disabled}
      options={kinds.map((k) => ({ value: k, label: kindNames[k] }))}
    />
  );
}

/**
 * The row Add Status puts in, its name focused: sent with the rest once named, as an In progress
 * Status; its kind can be changed like any other's after.
 */
function DraftRow({
  rows,
  at,
  commit,
  onDone,
}: {
  rows: Row[];
  at: number;
  commit: (next: Row[]) => boolean;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const kind: StatusKind = "in_progress";
  const send = () => {
    if (!name.trim()) return onDone();
    const next = [...rows.slice(0, at), { key: "new", name: name.trim(), kind }, ...rows.slice(at)];
    if (commit(next)) onDone();
  };
  return (
    <div role="row" aria-label="New Status" className={cn("grid h-11 items-center gap-3 border-b bg-background px-2", cols)}>
      <span />
      <span role="cell" className="flex">
        <StatusGlyph glyph={glyphFor(kind, 1)} />
      </span>
      <span role="cell" className="min-w-0">
        <Input
          aria-label="Name of the new Status"
          placeholder="Status name"
          autoFocus
          maxLength={50}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              send();
            }
            if (e.key === "Escape") onDone();
          }}
          onBlur={send}
          className="h-7 w-full sm:w-[220px]"
        />
      </span>
      <span className="hidden sm:block" />
      <span role="cell">
        <KindSelect label="Kind of the new Status" value={kind} onChange={() => {}} disabled />
      </span>
      <span className="hidden sm:block" />
      <span />
    </div>
  );
}

/** Delete a Status, asking first; a Status Tasks are in asks which Status receives them. */
function DeleteStatusDialog({
  status,
  rows,
  current,
  counts,
  pending,
  error,
  onDelete,
  onClose,
}: {
  status: Status;
  rows: Row[];
  current: Status[];
  counts: Map<string, number>;
  pending: boolean;
  error: unknown;
  onDelete: (next: Row[], moves?: Record<string, string>) => boolean;
  onClose: () => void;
}) {
  const n = counts.get(status.id) ?? 0;
  const next = rows.filter((r) => r.id !== status.id);
  const targets = moveTargets(status, next);
  const [to, setTo] = useState(targets[0]?.id ?? "");
  const moves = n > 0 && to ? { [status.id]: to } : undefined;
  const p = problem(next, current, counts, moves);
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Delete ${status.name}?`}
      confirmLabel="Delete"
      onConfirm={() => onDelete(next, moves)}
      pending={pending}
      disabled={!!p}
      error={p ? new ApiError(0, p.code, p.message) : error}
    >
      {n === 0 ? (
        <p>No Tasks are in it.</p>
      ) : (
        <Facts>
          <Fact label="Moves">
            {count(n, "Task")} to
            {targets.length > 0 && (
              <Choice
                label="Status that receives them"
                className="w-[168px] font-normal"
                value={to}
                onChange={setTo}
                options={targets.map((r) => ({ value: r.id!, label: r.name }))}
              />
            )}
          </Fact>
        </Facts>
      )}
    </ConfirmDialog>
  );
}
