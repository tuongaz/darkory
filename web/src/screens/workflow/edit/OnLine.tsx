import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type Announcements, type DragEndEvent, type UniqueIdentifier } from "@dnd-kit/core";
import { SortableContext, useSortable } from "@dnd-kit/sortable";
import { ArrowRightIcon, MoreHorizontalIcon, PlusIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useId, useMemo, useRef, type KeyboardEvent, type ReactNode, type RefCallback } from "react";
import type { Project, Skill } from "@/api/client";
import { InfoTip } from "@/components/InfoTip";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Tip } from "@/components/Tip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { lineTopology } from "@/components/workflowLine/layout";
import { DONE_STATION, type LineWorkflow } from "@/components/workflowLine/model";
import { railParts, type Seg } from "@/components/workflowLine/rails";
import { RailLine } from "@/components/workflowLine/Vertical";
import { AFTER_HINT, AFTER_LABEL, ALSO_LABEL, FILES_LABEL, filesHint, HAND_LABEL, holdHint, START_LABEL } from "@/components/workflowLine/words";
import { cn } from "@/lib/utils";
import { same, type RecordConnector, type RecordStep, type WorkflowRecord } from "../bind";
import { nameMax } from "../edits";
import { asLine, isNewSkill, outcomes, stepsIn, wasTarget, workflowsOf, type Draft, type Group } from "./draft";
import type { Holder, Roster } from "./holders";
import type { OrgFacts } from "./reach";
import { SkillPicker, type SkillChoice } from "./SkillPicker";
import { StepOptions } from "./StepOptions";
import { TakenBy, type StepSkill } from "./TakenBy";

/*
 * The draft drawn on the Workflow line with its fields in place (vf-9): the same rail, stations,
 * tracks and groups the live line draws, each Step a row of fields (a grip, its name, its Skill, who
 * takes it, a ⋯ menu), each outcome editable where the line draws it (the one the rail carries
 * under its station, the rest beside it), "+ Outcome" last under each Step. What an edit added or
 * changed is drawn in the waiting blue (vf-9; no Task is drawn while editing, so the hue means one thing here). No Task is drawn. Every edit is the draft's.
 */

const DONE = "@done";
const toValue = (to: string | undefined) => to ?? DONE;
const fromValue = (v: string) => (v === DONE ? undefined : v);

export type OnLineActions = {
  renameStep: (id: string, name: string) => void;
  /** Ends a run of typing in a field. */
  settle: () => void;
  skill: (id: string, choice: SkillChoice) => void;
  reorder: (id: string, by: -1 | 1) => void;
  moveTo: (id: string, onto: string) => void;
  /** Adds a Step after `id` in its group (at the end of `group` when `id` is undefined). */
  insertAfter: (id: string | undefined, group?: Group) => void;
  deleteStep: (id: string) => void;
  moveToWorkflow: (id: string, workflowId: string) => void;
  addTaker: (id: string, member: string, join: boolean) => void;
  removeTaker: (id: string, member: string) => void;
  renameOutcome: (id: string, name: string) => void;
  target: (id: string, to: string | undefined) => void;
  removeOutcome: (id: string) => void;
  addOutcome: (from: string) => void;
  main: (id: string) => void;
};

const stepWord = (s: Pick<RecordStep, "name">) => s.name.trim() || "the new Step";

export function OnLine({
  project,
  draft,
  base,
  skills,
  workflowId,
  groups,
  holders,
  roster,
  facts,
  invalid,
  actions,
  inputRef,
  note,
}: {
  project: Project;
  draft: Draft;
  base: WorkflowRecord;
  skills: Skill[];
  /** The Workflow drawn. */
  workflowId: string | undefined;
  groups: (s: Pick<RecordStep, "id">) => Group;
  /** Who takes each Skill's Steps at Save; undefined while unknown. */
  holders?: Map<string, Holder[]>;
  roster: Roster | undefined;
  facts: OrgFacts | undefined;
  /** Save was pressed with something to fix: the fields needing it are marked. */
  invalid: boolean;
  actions: OnLineActions;
  /** Each field by the id of what it names (a Step, an outcome): where the focus goes once it is drawn. */
  inputRef: (id: string) => RefCallback<HTMLElement>;
  /** Under the line: what the draft moves (where New Tasks start). */
  note?: ReactNode;
}) {
  const wf = draft.wf;
  const skillMap = useMemo(() => new Map(skills.map((s) => [s.id, s])), [skills]);
  const workflows = workflowsOf(wf);
  const order = useMemo(() => stepsIn(wf, workflowId), [wf, workflowId]);
  const steps = useMemo(() => new Map(wf.steps.map((s) => [s.id, s])), [wf.steps]);
  const baseSteps = useMemo(() => new Map(base.steps.map((s) => [s.id, s])), [base.steps]);

  // The line as the live page draws it, but a new Step stays where it was put though nothing joins it yet.
  const line = useMemo<LineWorkflow>(() => {
    const drawn = workflows.length > 1 ? workflowId : undefined;
    const placed = new Map(order.filter((s) => !baseSteps.has(s.id)).map((s) => [s.id, groups(s)] as const));
    return { ...asLine(wf, skillMap, drawn), placed };
  }, [wf, skillMap, workflows.length, workflowId, order, baseSteps, groups]);
  const t = useMemo(() => lineTopology(line), [line]);
  const parts = useMemo(() => railParts(t), [t]);

  // What the draft changed: a Step added, renamed, given another Skill or moved; an outcome added, renamed or re-pointed.
  const changedStep = (id: string) => {
    const b = baseSteps.get(id);
    const s = steps.get(id);
    return !!s && (!b || b.name !== s.name.trim() || b.skill_id !== s.skill_id || b.workflow_id !== s.workflow_id);
  };
  const changedOutcome = useMemo(() => {
    const was = new Map(base.connectors.map((c) => [c.id, c]));
    return new Set(wf.connectors.filter((c) => !was.get(c.id) || was.get(c.id)!.to_step_id !== c.to_step_id || was.get(c.id)!.name !== c.name.trim()).map((c) => c.id));
  }, [wf.connectors, base.connectors]);

  const nameOf = (id: string | null | undefined) => (id && id !== DONE_STATION ? steps.get(id)?.name.trim() || "New Step" : "Done");
  const workflowName = (id: string) => workflows.find((w) => w.id === id)?.name.trim() || "New Workflow";
  // Where a Step's name is used already: another Step of the Project called the same, whatever its case.
  const clash = (s: RecordStep) => (s.name.trim() ? wf.steps.find((o) => o.id !== s.id && same(o.name, s.name)) : undefined);

  const onRail = useMemo(() => new Set([...parts.mainSegs, ...parts.quietSegs].flatMap((s) => (s?.connector ? [s.connector.id] : []))), [parts]);
  const holderNames = useMemo(() => new Map([...(holders ?? new Map<string, Holder[]>())].map(([id, list]) => [id, list.map((h) => h.name)])), [holders]);

  // Order: a Step dragged by its grip onto another's place in its group. Only the one dragged moves.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const a = steps.get(String(active.id));
    const o = steps.get(String(over.id));
    if (!a || !o || groups(a) !== groups(o)) return;
    actions.moveTo(a.id, o.id);
  };
  // What a drag says to a screen reader, in the Steps' names; the grip's own name says its keys.
  const dragName = (id: UniqueIdentifier | undefined) => (id === undefined ? "" : nameOf(String(id)));
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${dragName(active.id)}`,
    onDragOver: ({ active, over }) => (over && over.id !== active.id ? `${dragName(active.id)} over ${dragName(over.id)}` : undefined),
    onDragEnd: ({ active, over }) => (over && over.id !== active.id ? `Moved ${dragName(active.id)} to ${dragName(over.id)}'s place` : `${dragName(active.id)} stays`),
    onDragCancel: ({ active }) => `${dragName(active.id)} stays`,
  };
  const grips = useRef(new Map<string, HTMLButtonElement>());
  const canMove = (s: RecordStep, by: -1 | 1) => {
    const own = order.filter((x) => groups(x) === groups(s));
    const i = own.findIndex((x) => x.id === s.id);
    return i + by >= 0 && i + by < own.length;
  };

  const outcomeField = (c: RecordConnector, glyph?: string) => (
    <OutcomeField
      key={c.id}
      c={c}
      wf={wf}
      base={base}
      step={steps.get(c.from_step_id)!}
      main={outcomes(wf, c.from_step_id).length > 1 ? outcomes(wf, c.from_step_id)[0]?.id === c.id : undefined}
      glyph={glyph}
      changed={changedOutcome.has(c.id)}
      invalid={invalid}
      actions={actions}
      inputRef={inputRef}
      nameOf={nameOf}
    />
  );

  /** How an outcome beside its Step reads: back along the line, on along it, into Done, off it. */
  const glyphOf = (c: RecordConnector, stations: readonly string[]) => {
    if (!c.to_step_id) return undefined;
    const [a, b] = [stations.indexOf(c.from_step_id), stations.indexOf(c.to_step_id)];
    if (a < 0 || b < 0) return "↗";
    return b < a ? "↩" : "↪";
  };

  /** A Step's outcomes the rail does not carry, each a row of fields, then "+ Outcome", last. */
  const besides = (s: RecordStep, stations: readonly string[]) => {
    const out = outcomes(wf, s.id);
    return (
      <>
        {out.filter((c) => !onRail.has(c.id)).map((c) => outcomeField(c, glyphOf(c, stations)))}
        {out.length === 0 && s.skill_id && (
          <Tip label="Tasks here can only be moved by hand">
            <span tabIndex={0} className="inline-flex items-center gap-1 rounded-sm px-1 text-xs font-medium text-state-claimed outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
              <TriangleAlertIcon aria-hidden className="size-3.5" />
              No way out
            </span>
          </Tip>
        )}
        <button
          type="button"
          onClick={() => actions.addOutcome(s.id)}
          aria-label={`Add an outcome out of ${stepWord(s)}`}
          className="inline-flex h-6 items-center gap-1 rounded-md px-1 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <PlusIcon aria-hidden className="size-3" />
          Outcome
        </button>
      </>
    );
  };

  /** A crossing in from another Workflow, beside the Step it reaches: read, not edited here. */
  const entries = (id: string) =>
    t.entries
      .filter((e) => e.stepId === id)
      .map((e) => (
        <span key={e.connector.id} data-chip="entry" className="inline-flex h-5 items-center gap-1 rounded-full border px-[7px] text-[11px] font-medium whitespace-nowrap text-muted-foreground">
          {e.text.replace(/^from /, "")}
          <span aria-hidden>↙</span>
        </span>
      ));

  const head = (s: RecordStep) => (
    <StepHead
      step={s}
      clash={clash(s)}
      clashIn={(o) => workflowName(o.workflow_id)}
      changed={changedStep(s.id)}
      invalid={invalid}
      skills={skills}
      pending={draft.skills}
      holderNames={holderNames}
      holders={holders}
      project={project}
      draft={draft}
      roster={roster}
      facts={facts}
      workflows={workflows}
      canUp={canMove(s, -1)}
      canDown={canMove(s, 1)}
      actions={actions}
      inputRef={inputRef}
      gripRef={(el) => (el ? grips.current.set(s.id, el) : grips.current.delete(s.id))}
      onGripKey={(e) => {
        if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
        e.preventDefault();
        actions.reorder(s.id, e.key === "ArrowUp" ? -1 : 1);
        // The grip keeps the focus as its row moves.
        requestAnimationFrame(() => grips.current.get(s.id)?.focus());
      }}
      skillMap={skillMap}
    />
  );

  const segment = (s: NonNullable<Seg>) => {
    if (s.connector) {
      const c = wf.connectors.find((x) => x.id === s.connector!.id);
      return c ? outcomeField(c) : null;
    }
    return s.hand ? <span>by hand</span> : null;
  };

  // ---- Also starts here: the Steps before the start, the breakdown Step, the parked holds.
  const sideIds = (() => {
    const ids = new Set([...parts.lead, ...(t.before ? [t.before] : []), ...t.holds]);
    return order.filter((s) => ids.has(s.id));
  })();
  // What the live line says of a Step there, read: a parked hold moved on by hand into the start, the breakdown Step's Subtasks filed at it.
  const start = t.start !== undefined ? nameOf(t.start) : undefined;
  const sideMark = (s: RecordStep) => {
    const hold = t.holds.includes(s.id);
    if (!hold && s.id !== t.before) return null;
    return (
      <Tip label={hold ? holdHint(s.name) : filesHint(s.name, start)}>
        <span
          tabIndex={0}
          data-mark={hold ? "hand" : "files"}
          className={cn(
            "inline-flex items-center gap-1 rounded-[5px] px-[7px] py-0.5 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            hold ? "border border-dashed border-muted-foreground px-1.5 py-px text-muted-foreground" : "bg-muted",
          )}
        >
          <span aria-hidden className="font-semibold text-muted-foreground">
            {hold ? "⇢" : "↳"}
          </span>
          {start ?? (hold ? HAND_LABEL : FILES_LABEL)}
        </span>
      </Tip>
    );
  };
  const group = sideIds.length > 0 && (
    <div className="flex w-full min-w-0 basis-full items-start @3xl:basis-auto">
      <span aria-hidden className="relative mt-3 mr-2 hidden h-[1.5px] w-7 flex-none bg-muted-foreground @3xl:block">
        <span className="absolute top-[-4px] left-[-2px] border-y-[4.5px] border-r-[7px] border-y-transparent border-r-muted-foreground" />
      </span>
      <section aria-label={ALSO_LABEL} className="min-w-0 flex-1 rounded-md border px-2.5 pt-1 pb-1.5">
        <div className="text-[11px] font-medium text-muted-foreground">{ALSO_LABEL}</div>
        <div className="flex flex-col gap-1.5">
          {sideIds.map((s) => (
            <div key={s.id} data-side={s.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              {head(s)}
              {entries(s.id)}
              {sideMark(s)}
              {besides(s, [])}
            </div>
          ))}
        </div>
      </section>
    </div>
  );

  const { rail, mainSegs, mainTracks, quietStations, quietSegs, quietTracks } = parts;
  const first = rail[0];
  const startRow = first !== DONE_STATION && (
    <div data-start-row className="flex min-h-6 flex-wrap items-center gap-x-2.5 gap-y-1 pb-0.5">
      <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold">
        <span aria-hidden>↓</span>
        {t.afterOnly ? AFTER_LABEL : START_LABEL}
        {t.afterOnly && <InfoTip label={AFTER_LABEL}>{AFTER_HINT}</InfoTip>}
      </span>
      {entries(first)}
    </div>
  );
  // The Retrospective a Parent's end files, where this Workflow does not hold the Project's retro Step.
  const retro = (() => {
    if (line.drawn === undefined || line.steps.some((s) => s.workflow_id === line.drawn && s.skill?.name === "retro")) return undefined;
    const s = line.steps.find((x) => x.skill?.name === "retro");
    return s ? `${workflowName(s.workflow_id)} › ${s.name}` : undefined;
  })();

  const row = (stations: readonly string[], withGroup: boolean) => (id: string, i: number) => {
    if (id === DONE_STATION) {
      return {
        name: <span className="text-sm font-semibold">Done</span>,
        tasks: null,
        marks: withGroup && retro && (
          <span data-retro className="inline-flex items-center gap-1 rounded-[5px] bg-muted px-[7px] py-0.5 text-xs">
            <span aria-hidden className="font-semibold text-muted-foreground">
              ↗
            </span>
            {retro}
          </span>
        ),
      };
    }
    const s = steps.get(id)!;
    return {
      name: head(s),
      tasks: null,
      marks: (
        <>
          {(i > 0 || !withGroup) && entries(id)}
          {besides(s, stations)}
          {withGroup && i === 0 && group}
        </>
      ),
    };
  };

  const quietOnes = quietStations.filter((id) => id !== DONE_STATION).map((id) => steps.get(id)!);
  const lastAfter = order.filter((s) => groups(s) === "after").at(-1);
  const branch = !t.afterOnly && quietOnes.length > 0 && (
    <section aria-label={AFTER_LABEL} className="mt-3 border-t pt-2">
      <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
        {AFTER_LABEL}
        <InfoTip label={AFTER_LABEL}>{AFTER_HINT}</InfoTip>
      </div>
      <RailLine
        label={AFTER_LABEL}
        quiet
        wide
        stations={quietStations}
        segs={quietSegs}
        tracks={quietTracks}
        row={row(quietStations, false)}
        onTip={() => {}}
        name={nameOf}
        tone={(ids) => (ids.some((x) => changedOutcome.has(x)) ? "changed" : "plain")}
        holdAt={(id) => !!steps.get(id) && !steps.get(id)!.skill_id}
        isStart={() => false}
        changed={changedStep}
        segment={segment}
        measureKey={[draft]}
      />
      <button
        type="button"
        onClick={() => actions.insertAfter(lastAfter?.id, "after")}
        aria-label="Add a Step after a Parent"
        className="mt-1 ml-[30px] inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <PlusIcon aria-hidden className="size-3" />
        Step
      </button>
    </section>
  );

  return (
    <section aria-label="The line, editing" className="@container relative flex min-w-0 flex-col">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} accessibility={{ screenReaderInstructions: { draggable: "" }, announcements }}>
        <SortableContext items={order.map((s) => s.id)} strategy={() => null}>
          <RailLine
            label="Steps on the line"
            wide
            stations={rail}
            segs={mainSegs}
            tracks={mainTracks}
            before={startRow}
            row={row(rail, true)}
            onTip={() => {}}
            name={nameOf}
            tone={(ids) => (ids.some((x) => changedOutcome.has(x)) ? "changed" : "plain")}
            holdAt={(id) => !!steps.get(id) && !steps.get(id)!.skill_id}
            isStart={(id) => id === first && id !== DONE_STATION}
            changed={changedStep}
            segment={segment}
            measureKey={[draft]}
          />
          {branch}
        </SortableContext>
      </DndContext>
      {note}
    </section>
  );
}

/** One Step's fields on the line: its grip, name, Skill, who takes it, and its ⋯ menu. */
function StepHead({
  step,
  clash,
  clashIn,
  changed,
  invalid,
  skills,
  skillMap,
  pending,
  holderNames,
  holders,
  project,
  draft,
  roster,
  facts,
  workflows,
  canUp,
  canDown,
  actions,
  inputRef,
  gripRef,
  onGripKey,
}: {
  step: RecordStep;
  clash: RecordStep | undefined;
  clashIn: (s: RecordStep) => string;
  changed: boolean;
  invalid: boolean;
  skills: Skill[];
  skillMap: Map<string, Skill>;
  pending: Draft["skills"];
  holderNames: Map<string, string[]>;
  holders?: Map<string, Holder[]>;
  project: Project;
  draft: Draft;
  roster: Roster | undefined;
  facts: OrgFacts | undefined;
  workflows: ReturnType<typeof workflowsOf>;
  canUp: boolean;
  canDown: boolean;
  actions: OnLineActions;
  inputRef: (id: string) => RefCallback<HTMLElement>;
  gripRef: (el: HTMLButtonElement | null) => void;
  onGripKey: (e: KeyboardEvent) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging, isOver } = useSortable({ id: step.id });
  const word = stepWord(step);
  const clashId = useId();
  const empty = !step.name.trim();
  const skill = step.skill_id && !isNewSkill(step.skill_id) ? skillMap.get(step.skill_id) : undefined;
  const pendingName = isNewSkill(step.skill_id) ? pending[step.skill_id!]?.name : undefined;
  // The Skill who takes it is about: one that exists, or the new one made on Save.
  const stepSkill: StepSkill | undefined = skill ?? (pendingName ? { id: step.skill_id!, name: pendingName, builtin: false } : undefined);
  const { onKeyDown: dndKey, ...gripListeners } = listeners ?? {};
  // An item that puts the focus in a field (a Step added, the Step moved to another Workflow): the menu leaves it there as it closes.
  const focused = useRef(false);
  return (
    <div
      ref={setNodeRef}
      data-step-head={step.id}
      data-changed={changed ? "" : undefined}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
      }}
      className={cn(
        "relative flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1",
        isDragging && "z-20 rounded-md bg-background shadow-soft",
        isOver && !isDragging && "before:absolute before:inset-x-0 before:-top-1 before:h-0.5 before:rounded-full before:bg-ring",
      )}
    >
      <button
        type="button"
        ref={(el) => {
          setActivatorNodeRef(el);
          gripRef(el);
        }}
        {...attributes}
        {...gripListeners}
        role="button"
        aria-roledescription={undefined}
        aria-label={`Move ${word}: drag, or Alt+↑ and Alt+↓`}
        onKeyDown={(e) => {
          onGripKey(e);
          if (!e.defaultPrevented) (dndKey as ((e: KeyboardEvent) => void) | undefined)?.(e);
        }}
        className="-ml-1 flex h-6 w-3 flex-none cursor-grab touch-none items-center justify-center rounded-sm text-[13px] font-semibold tracking-[-3px] text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span aria-hidden>⋮⋮</span>
      </button>
      <input
        ref={inputRef(step.id)}
        value={step.name}
        placeholder="Name the Step"
        maxLength={nameMax}
        aria-label={`Name of ${word}`}
        aria-invalid={(invalid && empty) || !!clash || undefined}
        aria-describedby={clash ? clashId : undefined}
        onChange={(e) => actions.renameStep(step.id, e.target.value)}
        onBlur={actions.settle}
        onKeyDown={(e) => {
          if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            e.preventDefault();
            actions.reorder(step.id, e.key === "ArrowUp" ? -1 : 1);
          }
        }}
        style={{ width: `calc(${Math.max(step.name.length, 9)}ch + 18px)` }}
        className={cn(
          "h-7 max-w-[200px] min-w-0 rounded-md border border-input bg-background px-2 text-sm font-semibold outline-none placeholder:font-normal placeholder:text-muted-foreground",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30",
          changed && "border-state-waiting text-state-waiting",
        )}
      />
      {clash && (
        <span id={clashId} className="text-[11px] text-destructive">
          Named already in {clashIn(clash)}
        </span>
      )}
      <SkillPicker
        value={step.skill_id}
        label={`Skill of ${word}`}
        skills={skills}
        pending={pending}
        holders={holderNames}
        onChange={(choice) => actions.skill(step.id, choice)}
        className="h-6 w-auto max-w-[150px] gap-1 px-1.5 text-[11px]"
      />
      {stepSkill && (
        <Takers
          step={step}
          word={word}
          skill={stepSkill}
          takers={holders ? (holders.get(stepSkill.id) ?? []) : undefined}
          project={project}
          draft={draft}
          roster={roster}
          facts={facts}
          actions={actions}
        />
      )}
      {/* Not modal: a field an item focuses keeps the focus as the menu closes. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`More for ${word}`}
            className="inline-flex size-6 flex-none items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-accent"
          >
            <MoreHorizontalIcon aria-hidden className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-56"
          onCloseAutoFocus={(e) => {
            if (focused.current) e.preventDefault();
            focused.current = false;
          }}
        >
          <DropdownMenuItem disabled={!canUp} onSelect={() => actions.reorder(step.id, -1)}>
            Move up
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canDown} onSelect={() => actions.reorder(step.id, 1)}>
            Move down
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              focused.current = true;
              actions.insertAfter(step.id);
            }}
          >
            Add Step after {word}
          </DropdownMenuItem>
          {workflows.length > 1 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Move to Workflow</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {workflows
                  .filter((w) => w.id !== step.workflow_id)
                  .map((w) => (
                    <DropdownMenuItem
                      key={w.id}
                      onSelect={() => {
                        focused.current = true;
                        actions.moveToWorkflow(step.id, w.id);
                      }}
                    >
                      {w.name.trim() || "New Workflow"}
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => actions.deleteStep(step.id)}>
            Delete {word}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * Who takes a Step's Tasks, as the line draws them: their avatars ("Nobody" when no one does,
 * and each Task's Owner takes it). A click opens who takes it to change, in the draft.
 */
function Takers({
  step,
  word,
  skill,
  takers,
  project,
  draft,
  roster,
  facts,
  actions,
}: {
  step: RecordStep;
  word: string;
  skill: StepSkill;
  takers: Holder[] | undefined;
  project: Project;
  draft: Draft;
  roster: Roster | undefined;
  facts: OrgFacts | undefined;
  actions: OnLineActions;
}) {
  // Kept mounted while who takes it is read again (a Member just made): what it opened stays open.
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Who takes ${word}`}
          className="inline-flex h-6 items-center rounded-full px-0.5 outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-accent"
        >
          {!takers ? (
            <span className="px-1 text-xs text-muted-foreground">…</span>
          ) : takers.length === 0 ? (
            <span className="px-1 text-xs font-medium text-state-claimed">Nobody</span>
          ) : (
            <>
              {takers.slice(0, 3).map((m, i) => (
                <MemberAvatar key={m.id} member={m} card={false} className={cn(i > 0 && "-ml-0.5")} />
              ))}
              {takers.length > 3 && <span className="pl-1 text-[11px] text-muted-foreground">+{takers.length - 3}</span>}
              <span className="sr-only">{takers.map((m) => m.name).join(", ")}</span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[360px] max-w-[calc(100vw-32px)] p-3"
        // A dialog it opens (Remove asks first, New agent) is outside it: it stays open behind.
        onInteractOutside={(e) => (e.target as Element | null)?.closest?.("[role=dialog],[role=alertdialog]") && e.preventDefault()}
        onFocusOutside={(e) => (e.target as Element | null)?.closest?.("[role=dialog],[role=alertdialog]") && e.preventDefault()}
      >
        <TakenBy
          project={project}
          stepId={step.id}
          skill={skill}
          draft={draft}
          holders={takers}
          roster={roster}
          facts={facts}
          readOnly={false}
          onAdd={(member, join) => actions.addTaker(step.id, member, join)}
          onRemove={(member) => actions.removeTaker(step.id, member)}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * One outcome where the line draws it: the main-way dot (of a Step with two or more), its glyph
 * beside the Step (↩ back, ↪ on, ● Done, ↗ off the line), its name, the Step it leads to (its own
 * Workflow's Steps, then each other Workflow's under its name, then Done), where it led before
 * this editing with undo, and ×.
 */
function OutcomeField({
  c,
  wf,
  base,
  step,
  main,
  glyph,
  changed,
  invalid,
  actions,
  inputRef,
  nameOf,
}: {
  c: RecordConnector;
  wf: WorkflowRecord;
  base: WorkflowRecord;
  step: RecordStep;
  /** Whether it is the main way on, of a Step with two or more; undefined with one. */
  main: boolean | undefined;
  glyph?: string;
  changed: boolean;
  invalid: boolean;
  actions: OnLineActions;
  inputRef: (id: string) => RefCallback<HTMLElement>;
  nameOf: (id: string | undefined) => string;
}) {
  const word = stepWord(step);
  const name = c.name.trim();
  const was = wasTarget(base, c);
  const wasName = was && ((was.to && (wf.steps.find((s) => s.id === was.to) ?? base.steps.find((s) => s.id === was.to))?.name.trim()) || (was.to ? "New Step" : "Done"));
  return (
    <span data-outcome={c.id} data-changed={changed ? "" : undefined} className={cn("inline-flex max-w-full flex-wrap items-center gap-1 rounded-md px-0.5 text-xs", changed && "text-state-waiting ring-1 ring-state-waiting")}>
      {main !== undefined && (
        <Tip label={main ? "Main: the line follows it" : "Make it the main way on"}>
          <button
            type="button"
            aria-pressed={main}
            aria-label={`${name || "the outcome"} out of ${word}: the main way on`}
            onClick={() => actions.main(c.id)}
            className="flex size-4 flex-none items-center justify-center rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <span className={cn("size-2.5 rounded-full border-[1.5px] border-muted-foreground", main && "border-foreground bg-foreground")} />
          </button>
        </Tip>
      )}
      {glyph && (
        <span aria-hidden className={cn("font-semibold", !changed && "text-muted-foreground")}>
          {glyph}
        </span>
      )}
      <input
        ref={inputRef(c.id)}
        value={c.name}
        placeholder="outcome"
        maxLength={nameMax}
        aria-label={name ? `Outcome ${name} out of ${word}` : `Outcome out of ${word}`}
        aria-invalid={(invalid && !name) || undefined}
        onChange={(e) => actions.renameOutcome(c.id, e.target.value)}
        onBlur={actions.settle}
        style={{ width: `calc(${Math.max(c.name.length, 4)}ch + 12px)` }}
        className={cn(
          "h-6 max-w-[180px] min-w-0 rounded-md border border-transparent bg-transparent px-1 text-xs outline-none placeholder:text-muted-foreground hover:border-input",
          "focus-visible:border-ring focus-visible:bg-background focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive",
        )}
      />
      <ArrowRightIcon aria-hidden className="size-3 flex-none text-muted-foreground" />
      <Select value={toValue(c.to_step_id)} onValueChange={(v) => actions.target(c.id, fromValue(v))}>
        <SelectTrigger
          size="sm"
          aria-label={`Where ${name || "the outcome"} out of ${word} leads`}
          className={cn(
            "h-6! w-auto max-w-[200px] gap-1 border-transparent bg-transparent px-1 py-0 text-xs font-medium shadow-none hover:border-input data-[size=sm]:h-6 dark:bg-transparent [&_svg]:size-3!",
          )}
        >
          <SelectValue>{nameOf(c.to_step_id)}</SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          <StepOptions wf={wf} first={step.workflow_id} offered={(s) => s.id !== step.id} />
          <SelectSeparator />
          <SelectItem value={DONE}>Done</SelectItem>
        </SelectContent>
      </Select>
      {was && (
        <>
          <s className="text-[11px] text-muted-foreground">
            <span className="sr-only">was </span>
            {wasName}
          </s>
          <button
            type="button"
            onClick={() => actions.target(c.id, was.to)}
            aria-label={`Undo: lead ${name || "the outcome"} back to ${wasName}`}
            className="rounded-sm text-[11px] text-muted-foreground underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            undo
          </button>
        </>
      )}
      <button
        type="button"
        onClick={() => actions.removeOutcome(c.id)}
        aria-label={`Remove ${name || "the outcome"} out of ${word}`}
        className="inline-flex size-5 flex-none items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <XIcon aria-hidden className="size-3" />
      </button>
    </span>
  );
}
