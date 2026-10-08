import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { GripVerticalIcon, PlusIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefCallback } from "react";
import type { Skill } from "@/api/client";
import { cn } from "@/lib/utils";
import type { RecordStep, WorkflowRecord } from "../bind";
import { nameMax } from "../edits";
import { DeleteStepDialog } from "./DeleteStep";
import {
  addOutcome,
  deadEndsAfterDelete,
  deleteStep,
  inOrder,
  insertStep,
  moveStepTo,
  outcomes,
  removeOutcome,
  renameOutcome,
  renameStep,
  reorderStep,
  setSkill,
  setTarget,
  tasksAt,
  type Draft,
  type Group,
} from "./draft";
import { AddOutcome, Outcome, type OutcomeActions } from "./Outcomes";
import { SkillPicker } from "./SkillPicker";
import type { DraftEditor } from "./useDraft";

/*
 * The Workflow as a plain ordered list: one row per Step, its Name, its Skill and its first outcome
 * on the row, its other outcomes under it; "+ Add Step" between rows; the Steps after a Parent in
 * their own group. Rows reorder by their grip or Alt+↑/↓ within their group.
 */

const grid = "md:grid md:grid-cols-[22px_210px_150px_18px_minmax(0,1fr)] md:items-center md:gap-x-2.5";

export function StepList({
  editor,
  draft,
  base,
  skills,
  groups,
  readOnly,
  focusStep,
}: {
  editor?: DraftEditor;
  draft: Draft;
  base: WorkflowRecord;
  skills: Skill[];
  groups: (s: RecordStep) => Group;
  readOnly: boolean;
  /** The Step whose name takes the focus when the list opens: `?step=` from the live page. */
  focusStep?: string;
}) {
  const wf = draft.wf;
  const order = inOrder(wf.steps);
  const main = order.filter((s) => groups(s) === "main");
  const after = order.filter((s) => groups(s) === "after");
  const number = new Map([...main, ...after].map((s, i) => [s.id, i + 1]));
  const apply = (edit: (d: Draft) => Draft, key?: string) => editor?.apply(edit, key);
  const invalid = !!editor?.tried && !!editor.problem;

  // The field to focus once it is drawn: a new Step's name, a new outcome's.
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const [focus, setFocus] = useState<string | undefined>(focusStep);
  useEffect(() => {
    if (!focus) return;
    const el = inputs.current.get(focus);
    if (el) {
      el.focus();
      el.scrollIntoView?.({ block: "nearest" });
      setFocus(undefined);
    }
  }, [focus, wf]);
  const inputRef =
    (id: string): RefCallback<HTMLInputElement> =>
    (el) => {
      if (el) inputs.current.set(id, el);
      else inputs.current.delete(id);
    };

  // Reordering moves the row in the page: what had the focus keeps it.
  const refocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = refocus.current;
    refocus.current = null;
    if (el && el.isConnected && document.activeElement !== el) el.focus();
  }, [wf]);

  const [deleting, setDeleting] = useState<RecordStep | undefined>();
  const askDelete = (s: RecordStep) => {
    if (tasksAt(draft, s.id) > 0 || deadEndsAfterDelete(draft, s.id).length > 0) setDeleting(s);
    else apply((d) => deleteStep(d, s.id));
  };

  const insert = (after: string | undefined) => {
    let made = "";
    apply((d) => {
      const r = insertStep(d, after, groups);
      made = r.id;
      return r.draft;
    });
    if (made) setFocus(made);
  };

  const actions: OutcomeActions = {
    rename: (id, name) => apply((d) => renameOutcome(d, id, name), `outcome:${id}`),
    settle: () => editor?.settle(),
    target: (id, to) => apply((d) => setTarget(d, id, to)),
    remove: (id) => apply((d) => removeOutcome(d, id)),
    add: (from) => {
      let made = "";
      apply((d) => {
        const r = addOutcome(d, from);
        made = r.id;
        return r.draft;
      });
      if (made) setFocus(made);
    },
  };

  const holders = new Map<string, string[]>();
  for (const s of base.steps)
    if (s.skill_id && s.takers.length)
      holders.set(
        s.skill_id,
        s.takers.map((t) => t.name),
      );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const a = wf.steps.find((s) => s.id === active.id);
    const o = wf.steps.find((s) => s.id === over.id);
    if (!a || !o || groups(a) !== groups(o)) return;
    apply((d) => moveStepTo(d, a.id, o.id));
  };

  const row = (s: RecordStep) => (
    <StepRow
      key={s.id}
      step={s}
      n={number.get(s.id)!}
      draft={draft}
      base={base}
      order={order}
      skills={skills}
      holders={holders}
      readOnly={readOnly}
      invalid={invalid}
      actions={actions}
      inputRef={inputRef}
      onRename={(name) => apply((d) => renameStep(d, s.id, name), `name:${s.id}`)}
      onSettle={() => editor?.settle()}
      onSkill={(choice) => apply((d) => setSkill(d, s.id, choice))}
      onReorder={(by) => {
        refocus.current = document.activeElement as HTMLElement | null;
        apply((d) => reorderStep(d, s.id, by, groups));
      }}
      onDelete={() => askDelete(s)}
    />
  );

  const gap = (s: RecordStep, last: boolean) => (readOnly ? null : <InsertGap key={`gap-${s.id}`} after={s} last={last} onInsert={() => insert(s.id)} />);

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <div role="list" aria-label="Steps" className="flex flex-col">
        <SortableContext items={main.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          {main.map((s, i) => (
            <Fragment key={s.id}>
              {row(s)}
              {gap(s, i === main.length - 1)}
            </Fragment>
          ))}
        </SortableContext>
        {main.length === 0 && !readOnly && (
          <div className="py-2 md:pl-8">
            <button type="button" onClick={() => insert(undefined)} className={addStepClass + " opacity-100"}>
              <PlusIcon aria-hidden className="size-3" /> Add Step
            </button>
          </div>
        )}
        {after.length > 0 && (
          <>
            <div role="presentation" className={cn(grid, "mt-1 mb-1 text-xs text-muted-foreground max-md:mt-4 max-md:px-3")}>
              <span />
              <span>After a Parent</span>
            </div>
            <SortableContext items={after.map((s) => s.id)} strategy={verticalListSortingStrategy}>
              {after.map(row)}
            </SortableContext>
          </>
        )}
      </div>
      {deleting && editor && (
        <DeleteStepDialog
          draft={draft}
          step={deleting}
          order={order}
          onClose={() => setDeleting(undefined)}
          onDelete={(moveTo) => {
            apply((d) => deleteStep(d, deleting.id, moveTo));
            setDeleting(undefined);
          }}
        />
      )}
    </DndContext>
  );
}

const addStepClass =
  "inline-flex h-6 items-center gap-1 rounded-md border border-dashed border-input bg-background px-2 text-xs text-muted-foreground outline-none hover:border-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** The gap after a Step: "+ Add Step" shows on hover or focus, and inserts a Step there. */
function InsertGap({ after, last, onInsert }: { after: RecordStep; last: boolean; onInsert: () => void }) {
  return (
    <div className={cn("group/gap relative flex h-8 items-center px-3 md:h-2 md:pl-8", last && "md:h-7")}>
      <span aria-hidden className="absolute inset-x-8 top-1/2 h-px bg-border opacity-0 group-hover/gap:opacity-100" />
      <button
        type="button"
        onClick={onInsert}
        aria-label={`Add a Step after ${after.name.trim() || "the new Step"}`}
        className={cn(addStepClass, "relative z-10 opacity-0 group-hover/gap:opacity-100 focus-visible:opacity-100", "max-md:opacity-100")}
      >
        <PlusIcon aria-hidden className="size-3" /> Add Step
      </button>
    </div>
  );
}

function StepRow({
  step,
  n,
  draft,
  base,
  order,
  skills,
  holders,
  readOnly,
  invalid,
  actions,
  inputRef,
  onRename,
  onSettle,
  onSkill,
  onReorder,
  onDelete,
}: {
  step: RecordStep;
  n: number;
  draft: Draft;
  base: WorkflowRecord;
  order: RecordStep[];
  skills: Skill[];
  holders: Map<string, string[]>;
  readOnly: boolean;
  invalid: boolean;
  actions: OutcomeActions;
  inputRef: (id: string) => RefCallback<HTMLInputElement>;
  onRename: (name: string) => void;
  onSettle: () => void;
  onSkill: Parameters<typeof SkillPicker>[0]["onChange"];
  onReorder: (by: -1 | 1) => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: step.id, disabled: readOnly });
  const fresh = !base.steps.some((s) => s.id === step.id);
  const name = step.name.trim() || "the new Step";
  const { head, rest } = outcomeLines({ wf: draft.wf, base, step, order, readOnly, invalid, actions, nameRef: inputRef });
  const baseOut = new Set(base.connectors.map((c) => c.id));
  const skillName = step.skill_id ? (skills.find((s) => s.id === step.skill_id)?.name ?? draft.skills[step.skill_id]?.name) : undefined;

  const onKeyDown = (e: KeyboardEvent) => {
    if (readOnly || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    onReorder(e.key === "ArrowUp" ? -1 : 1);
  };

  const line = (cells: ReactNode, sub?: boolean, amber?: boolean, key?: string) => (
    <div
      key={key}
      className={cn(grid, "group/out flex min-w-0 flex-col gap-1.5 md:min-h-[34px]", sub && "md:min-h-[28px]", amber && "rounded-md bg-state-claimed-bg")}
    >
      {cells}
    </div>
  );

  return (
    <div
      ref={setNodeRef}
      role="listitem"
      aria-label={`${n}. ${step.name.trim() || "New Step"}`}
      onKeyDown={onKeyDown}
      style={{ transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined, transition }}
      className={cn(
        "group/row relative rounded-md px-0 py-1 max-md:border-b max-md:px-3 max-md:py-3",
        fresh && "bg-state-claimed-bg",
        isDragging && "z-20 bg-background shadow-soft",
      )}
    >
      {line(
        <>
          <span className="hidden text-right text-xs text-muted-foreground tabular-nums md:block">{n}</span>
          <div className="relative flex min-w-0 items-center gap-2">
            <span className="text-xs text-muted-foreground tabular-nums md:hidden">{n}</span>
            {readOnly ? (
              <span className="flex h-7 min-w-0 items-center truncate font-medium">{step.name}</span>
            ) : (
              <>
                <button
                  type="button"
                  ref={setActivatorNodeRef}
                  {...attributes}
                  {...listeners}
                  aria-label={`Reorder ${name}: drag, or Alt+↑ and Alt+↓`}
                  className="absolute left-1 z-10 flex h-5 w-4 cursor-grab touch-none items-center justify-center rounded-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 max-md:left-6"
                >
                  <GripVerticalIcon aria-hidden className="size-3.5" />
                </button>
                <input
                  ref={inputRef(step.id)}
                  value={step.name}
                  placeholder="Name the Step"
                  maxLength={nameMax}
                  aria-label={`Name of Step ${n}`}
                  aria-invalid={(invalid && !step.name.trim()) || undefined}
                  onChange={(e) => onRename(e.target.value)}
                  onBlur={onSettle}
                  className="h-7 w-full min-w-0 rounded-md border border-input bg-background pr-2 pl-6 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-foreground focus-visible:ring-[3px] focus-visible:ring-muted aria-invalid:border-destructive dark:bg-input/30"
                />
              </>
            )}
          </div>
          <div className="min-w-0">
            {readOnly ? (
              <span className={cn("font-mono text-[11.5px]", !skillName && "font-sans text-xs text-muted-foreground")}>{skillName ?? "hold · no Skill"}</span>
            ) : (
              <SkillPicker value={step.skill_id} label={`Skill of ${name}`} skills={skills} pending={draft.skills} holders={holders} onChange={onSkill} />
            )}
          </div>
          <span className="hidden md:block" />
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              {head}
              {!readOnly && rest.length === 0 && <AddOutcome step={step} onAdd={actions.add} />}
            </div>
            {!readOnly && (
              <button
                type="button"
                onClick={onDelete}
                aria-label={`Delete ${name}`}
                className="inline-flex size-6 flex-none items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:bg-accent hover:text-destructive focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 max-md:opacity-100"
              >
                <Trash2Icon aria-hidden className="size-3.5" />
              </button>
            )}
          </div>
        </>,
      )}
      {rest.map(({ c, node }, i) =>
        line(
          <>
            <span className="hidden md:block" />
            <span className="hidden md:block" />
            <span className="hidden md:block" />
            <span className="text-right text-xs text-muted-foreground max-md:hidden">if</span>
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-xs text-muted-foreground md:hidden">if</span>
              {node}
              {!readOnly && i === rest.length - 1 && <AddOutcome step={step} onAdd={actions.add} />}
            </div>
          </>,
          true,
          !fresh && !baseOut.has(c.id),
          c.id,
        ),
      )}
    </div>
  );
}

/**
 * A Step's outcomes as the list shows them: the first on the Step's own line, "pass → QA"; the
 * others under it, "if fail → Build"; an outcome pointed elsewhere by this editing shows where it
 * led struck through, with undo. "+ outcome" adds one. A hold with none is "moved by hand"; a
 * Step with a Skill and none has no way out.
 */
function outcomeLines(props: {
  wf: WorkflowRecord;
  base: WorkflowRecord;
  step: RecordStep;
  order: RecordStep[];
  readOnly: boolean;
  invalid: boolean;
  actions: OutcomeActions;
  nameRef: (id: string) => RefCallback<HTMLInputElement>;
}) {
  const { wf, step } = props;
  const out = outcomes(wf, step.id);
  const first = out[0];
  const rest = out.slice(1);
  const head = first ? (
    <Outcome {...props} c={first} />
  ) : step.skill_id ? (
    <span className="flex items-center gap-1.5 text-xs font-medium text-state-claimed">
      <TriangleAlertIcon aria-hidden className="size-3.5 flex-none" />
      No way out: Tasks here can only be moved by hand.
    </span>
  ) : (
    <span className="text-xs text-muted-foreground">moved by hand</span>
  );
  return { head, rest: rest.map((c) => ({ c, node: <Outcome key={c.id} {...props} c={c} /> })) };
}
