import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type Announcements, type DragEndEvent, type UniqueIdentifier } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode, type RefCallback } from "react";
import type { Project, Skill } from "@/api/client";
import { InfoTip } from "@/components/InfoTip";
import { Tip } from "@/components/Tip";
import { DONE_STATION } from "@/components/workflowLine/model";
import type { Seg } from "@/components/workflowLine/rails";
import { LineTip, RailLine, type Tip as LineHover } from "@/components/workflowLine/Vertical";
import { AFTER_HINT, AFTER_LABEL, ALSO_LABEL, FILES_LABEL, filesHint, HAND_LABEL, holdHint, START_LABEL } from "@/components/workflowLine/words";
import { cn } from "@/lib/utils";
import { same, type RecordConnector, type RecordStep, type WorkflowRecord } from "../bind";
import { outcomes, reordered, stepsIn, workflowsOf, type Draft, type Group } from "./draft";
import { useDraftLine } from "./draftLine";
import type { Holder, Roster } from "./holders";
import { stepWord, type OnLineActions } from "./lineEdit";
import { OutcomeField } from "./OutcomeField";
import type { OrgFacts } from "./reach";
import { StepHead } from "./StepHead";

/*
 * The draft drawn on the Workflow line with its fields in place (vf-9): the same rail, stations,
 * tracks and groups the live line draws, each Step a row of fields (a grip, its name, its Skill, who
 * takes it, a ⋯ menu), each outcome editable where the line draws it (the one the rail carries
 * under its station, the rest beside it), "+ Outcome" last under each Step. What an edit added or
 * changed is drawn in the waiting blue (vf-9). No Task is drawn, so that hue means one thing
 * here. Its lines and words say what they mean on hover, as the live line's do. Every edit is the
 * draft's.
 */

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
  // What a line, a track or a station means, while the pointer is on it: the live line's sentences.
  const [tip, setTip] = useState<LineHover | null>(null);
  const order = useMemo(() => stepsIn(wf, workflowId), [wf, workflowId]);
  const steps = useMemo(() => new Map(wf.steps.map((s) => [s.id, s])), [wf.steps]);
  const baseSteps = useMemo(() => new Map(base.steps.map((s) => [s.id, s])), [base.steps]);

  // The line as the live page draws it, but a new Step stays where it was put though nothing joins it yet;
  // laid out again only when its structure changes, never as a name is typed.
  const drawn = workflows.length > 1 ? workflowId : undefined;
  const placed = new Map(order.filter((s) => !baseSteps.has(s.id)).map((s) => [s.id, groups(s)] as const));
  const { key, t, parts } = useDraftLine(wf, skillMap, drawn, placed);
  // The rows' heights follow the names' lengths (a field wraps): measured again when they change.
  const measureKey = [key, wf.steps.map((s) => s.name.length).join(","), wf.connectors.map((c) => c.name.length).join(",")];

  // What the draft changed: a Step added, renamed, given another Skill, moved into another Workflow
  // or along its own (the fewest moves, as the changes list says them); an outcome added, renamed or
  // re-pointed. Who takes a Step is not drawn here: the changes list says it.
  const moved = useMemo(() => reordered(base, wf), [base, wf]);
  const changedStep = (id: string) => {
    const b = baseSteps.get(id);
    const s = steps.get(id);
    return !!s && (!b || b.name !== s.name.trim() || b.skill_id !== s.skill_id || b.workflow_id !== s.workflow_id || moved.has(id));
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

  const outcomeField = (c: RecordConnector, glyph?: string) => {
    const out = outcomes(wf, c.from_step_id);
    return (
      <OutcomeField
        key={c.id}
        c={c}
        wf={wf}
        base={base}
        step={steps.get(c.from_step_id)!}
        main={out.length > 1 ? out[0]?.id === c.id : undefined}
        glyph={glyph}
        changed={changedOutcome.has(c.id)}
        invalid={invalid}
        actions={actions}
        inputRef={inputRef}
        nameOf={nameOf}
      />
    );
  };

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
    const isRetro = (s: RecordStep) => !!s.skill_id && skillMap.get(s.skill_id)?.name === "retro";
    if (drawn === undefined || wf.steps.some((s) => s.workflow_id === drawn && isRetro(s))) return undefined;
    const s = wf.steps.find(isRetro);
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
        onTip={setTip}
        name={nameOf}
        tone={(ids) => (ids.some((x) => changedOutcome.has(x)) ? "changed" : "plain")}
        holdAt={(id) => !!steps.get(id) && !steps.get(id)!.skill_id}
        isStart={() => false}
        changed={changedStep}
        segment={segment}
        measureKey={measureKey}
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
    <section aria-label="The line, editing" data-line-root className="@container relative flex min-w-0 flex-col">
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
            onTip={setTip}
            name={nameOf}
            tone={(ids) => (ids.some((x) => changedOutcome.has(x)) ? "changed" : "plain")}
            holdAt={(id) => !!steps.get(id) && !steps.get(id)!.skill_id}
            isStart={(id) => id === first && id !== DONE_STATION}
            changed={changedStep}
            segment={segment}
            measureKey={measureKey}
          />
          {branch}
        </SortableContext>
      </DndContext>
      {note}
      <LineTip tip={tip} />
    </section>
  );
}
