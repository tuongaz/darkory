import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { TagIcon } from "lucide-react";
import { InfoTip } from "@/components/InfoTip";
import { MemberAvatar } from "@/components/MemberAvatar";
import { DONE, DROPPED, type FlowState, type Token as FlowToken } from "@/components/workflow/live";
import { spanText } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { Ghost, Trace } from "./data";
import { chipsAt, laneTracks, railOf, tracks as railTracks, type LaneTrack, type LineTopology } from "./layout";
import { DONE_STATION, isHoldStep, PICKUP_MS, tokenTime, type LineConnector, type LineFacts, type LineStepFacts, type LineTask } from "./model";
import { GhostToken, HiddenCount, Token } from "./Token";
import {
  AFTER_BRANCH,
  AFTER_HINT,
  AFTER_LABEL,
  ALSO_LABEL,
  arriveHint,
  breakdownOutcomeHint,
  entryHint,
  FILES_LABEL,
  filesHint,
  gapHint,
  HAND_LABEL,
  handHint,
  holdHint,
  HOLD_PILL,
  MEDIAN_HINT,
  outcomeHint,
  outcomesHint,
  retroHint,
  SKILL_HINT,
  START_LABEL,
} from "./words";

/*
 * The Workflow line, top to bottom at every width (the final design, vf-1 … vf-6): the rail down
 * the card's left from Start, the start Step's station filled; each Step a row (name · Skill tag ·
 * median · takers | its Tasks | what leaves the line); between two stations the outcome's name and
 * an arrowhead; returns and skips as tracks in lanes beside the rail, one per Step reached; marks
 * only for what leaves the line. "Also starts here" stands beside the start Step's row (under it
 * in a narrow card), the Steps carrying the branch's Skills a quiet line of their own under a
 * divider, "When a Parent ends".
 */

/** The rail's x: the centre of its 22px column. */
const RAIL = 11;
/** How wide the lanes' column runs past its tracks, and how far apart lanes run. */
const LANE0 = 10;
const LANE = 12;
/** How far above or below a station's centre a track's stub meets it. */
const STUB = 5;

type Hover = (text: string | undefined) => Record<string, unknown>;

/** How a Connector reads: on a traced Task's way, one of its next moves, carrying a token now, changed by an edit, or as it is. */
type Tone = "trace" | "next" | "lit" | "changed" | "plain";

/** A pair of neighbours on a rail: along a Connector, by hand, a gap no outcome runs along; `null` draws nothing (between two rows of the branch). */
type Seg = { from: string; to: string; connector?: LineConnector; hand?: boolean } | null;

/** A mark beside a Step, for what leaves the line: into Done, another Workflow, by hand, a Breakdown's Subtasks. */
type MarkKind = "done" | "exit" | "hand" | "files" | "chip";

const glyphs: Record<MarkKind, string> = { done: "●", exit: "↗", hand: "⇢", files: "↳", chip: "↗" };

export function VerticalLine({
  topology: t,
  facts,
  tasks,
  hidden,
  done,
  ghosts,
  branchLabel,
  doneToday,
  trace,
  flow,
  now,
  selected,
  onSelect,
  ringed,
  onOpenTask,
  highlight,
  noBranch,
  footer,
}: {
  topology: LineTopology;
  facts: LineFacts;
  tasks: readonly LineTask[];
  hidden?: ReadonlyMap<string, number>;
  done?: readonly { id: string; key: string; title: string }[];
  ghosts?: readonly Ghost[];
  branchLabel: string;
  doneToday?: number;
  trace?: Trace;
  flow: FlowState;
  now: number;
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  ringed?: ReadonlySet<string>;
  onOpenTask?: (key: string) => void;
  highlight?: ReadonlySet<string>;
  noBranch?: boolean;
  footer?: ReactNode;
}) {
  const steps = useMemo(() => new Map(facts.steps.map((s) => [s.id, s])), [facts.steps]);
  const { lead, rail } = useMemo(() => railOf(t), [t]);
  const mainTracks = useMemo(() => railTracks(t), [t]);

  // What a line or a word means, in a sentence, while the pointer is on it.
  const [tip, setTip] = useState<{ x: number; y: number; w: number; text: string } | null>(null);
  const hover: Hover = (text) =>
    text
      ? {
          "data-hint": text,
          onMouseEnter: (e: MouseEvent) => {
            const r = (e.currentTarget as Element).closest("[data-line-root]")?.getBoundingClientRect();
            if (r) setTip({ x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, text });
          },
          onMouseLeave: () => setTip(null),
        }
      : {};

  const at = new Map<string, LineTask[]>();
  for (const task of tasks) if (task.stepId && !flow.transit.has(task.id)) at.set(task.stepId, [...(at.get(task.stepId) ?? []), task]);
  for (const list of at.values()) list.sort((a, b) => Number(!!b.holder) - Number(!!a.holder) || (a.since ?? 0) - (b.since ?? 0));

  const traversed = new Set(trace?.traversed ?? []);
  const next = new Set(trace?.next ?? []);
  const name = (id: string | null) => (id === null || id === DONE_STATION ? "Done" : (steps.get(id)?.name ?? t.others.get(id) ?? "a Step"));
  const fullName = (id: string | null) => (id !== null && t.others.has(id) ? t.others.get(id)! : name(id));
  const tone = (ids: readonly string[]): Tone =>
    ids.some((id) => traversed.has(id)) ? "trace" : ids.some((id) => next.has(id)) ? "next" : ids.some((id) => flow.lit.has(id)) ? "lit" : ids.some((id) => highlight?.has(id)) ? "changed" : "plain";
  const stays = new Map((trace?.stays ?? []).filter((s) => s.until !== undefined).map((s) => [s.stepId, s]));
  const start = t.start !== undefined ? name(t.start) : undefined;

  const tagFor = (task: LineTask): ReactNode => {
    if (task.holder && task.heldSince !== undefined && now - task.heldSince < PICKUP_MS) {
      const waited = task.since !== undefined ? task.heldSince - task.since : undefined;
      return (
        <>
          <span className="rounded-full bg-foreground px-1.5 text-[11px] leading-[18px] text-background">now</span>
          <span>{task.holder.name} picked up</span>
          {waited !== undefined && waited > 60_000 && <span className="text-muted-foreground">· waited {tokenTime(waited)}</span>}
          <span aria-hidden className="h-[1.5px] w-3 bg-state-claimed" />
        </>
      );
    }
    const said = task.stepId ? flow.callouts.get(task.stepId)?.find((c) => c.taskId === task.id) : undefined;
    if (said && said.tone !== "agent" && said.tone !== "human") {
      return (
        <>
          <span className="rounded-full border bg-background px-1.5 text-[11px] leading-[18px]">{said.text.replace(` ${task.key}`, "")}</span>
          <span aria-hidden className="h-[1.5px] w-3 bg-border" />
        </>
      );
    }
    return undefined;
  };

  const token = (task: LineTask) => {
    const s = task.stepId ? steps.get(task.stepId) : undefined;
    return (
      <Token
        key={task.id}
        task={task}
        hold={!!s && isHoldStep(s)}
        now={now}
        selected={selected === task.id}
        ringed={!!ringed?.has(task.id)}
        pulse={flow.pulses.get(task.id)}
        arrived={flow.arrived.has(task.id)}
        tag={trace ? undefined : tagFor(task)}
        tagSide="right"
        onClick={onSelect ? () => onSelect(selected === task.id ? null : task.id) : onOpenTask && (() => onOpenTask(task.key))}
        noKey={!!trace}
      />
    );
  };

  const mark = (kind: MarkKind, key: string, text: string, hint: string | undefined, extra: Record<string, unknown> = {}) => (
    <span
      key={key}
      data-mark={kind}
      {...extra}
      {...hover(hint)}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-[5px] px-[7px] py-0.5 text-xs leading-[1.4]",
        kind === "done" ? "bg-state-done-bg" : kind === "hand" ? "border border-dashed border-muted-foreground px-1.5 py-px text-muted-foreground" : "bg-muted",
        !!extra["data-connector"] && highlight?.has(extra["data-connector"] as string) && "ring-1 ring-ring",
      )}
    >
      <span aria-hidden className={cn("font-semibold", kind === "done" ? "text-state-done" : "text-muted-foreground")}>
        {glyphs[kind]}
      </span>{" "}
      <span className="min-w-0 truncate">{text}</span>
    </span>
  );
  /** "done → Done" says Done once; "pass → Triage" both. */
  const said = (c: LineConnector, target: string) => (c.name.toLowerCase() === target.toLowerCase() ? target : `${c.name} → ${target}`);

  // A crossing in, beside the Step it reaches (beside Start, where that is the first): "Bug triage · feature ↙".
  const entryChips = (id: string) =>
    t.entries
      .filter((e) => e.stepId === id)
      .map((e) => (
        <span
          key={e.connector.id}
          data-chip="entry"
          data-arrival={id}
          data-connector={e.connector.id}
          data-lit={traversed.has(e.connector.id) ? "true" : undefined}
          {...hover(e.hint)}
          className={cn(
            "inline-flex h-5 items-center gap-1 rounded-full border px-[7px] text-[11px] font-medium whitespace-nowrap text-muted-foreground",
            traversed.has(e.connector.id) && "border-state-claimed text-state-claimed",
          )}
        >
          {e.text.replace(/^from /, "")}
          <span aria-hidden>↙</span>
        </span>
      ));

  // A Step's Connectors that leave its line: Done (not along the rail), another Workflow, a Step off the rail.
  const leaves = (id: string, carried: ReadonlySet<string>): ReactNode[] => {
    const out: ReactNode[] = [];
    for (const c of t.connectors.values()) {
      if (c.from !== id || carried.has(c.id)) continue;
      if (c.to === null) out.push(mark("done", c.id, said(c, "Done"), outcomeHint(c, fullName), { "data-connector": c.id }));
      else out.push(mark("chip", c.id, said(c, fullName(c.to)), outcomeHint(c, fullName), { "data-connector": c.id, "data-chip": "chip" }));
    }
    for (const e of t.exits.filter((x) => x.stepId === id)) {
      out.push(mark("exit", e.connector.id, said(e.connector, fullName(e.connector.to)), e.hint, { "data-connector": e.connector.id, "data-chip": "exit", "data-exit": e.connector.id }));
    }
    return out;
  };

  const facts1 = (s: LineStepFacts | undefined, small = false) => {
    if (!s) return null;
    const takers = s.takers ?? [];
    const paused = takers.length > 0 && takers.every((m) => m.paused);
    return (
      <>
        {s.skill && (
          <span {...hover(SKILL_HINT)} className="inline-flex items-center gap-[3px] font-mono text-[11px] font-normal text-muted-foreground">
            <TagIcon aria-hidden className="size-[11px]" />
            {s.skill.name}
          </span>
        )}
        {s.medianMs !== undefined && (
          <span {...hover(MEDIAN_HINT)} className="text-xs font-normal text-muted-foreground tabular-nums">
            {spanText(s.medianMs)}
          </span>
        )}
        {paused ? (
          <span className="rounded-full border px-1.5 text-[10.5px] leading-4 font-normal text-muted-foreground">paused</span>
        ) : (
          takers.length > 0 && (
            <span className={cn("inline-flex items-center", small && "scale-95")}>
              {takers.map((m, i) => (
                <MemberAvatar key={m.id} member={m} working={m.working} className={cn(i > 0 && "-ml-0.5")} />
              ))}
            </span>
          )
        )}
      </>
    );
  };

  const holdPill = (stepName: string) => (
    <>
      <span className="rounded-full border px-1.5 text-[11px] leading-[18px] font-medium">{HOLD_PILL}</span>
      <InfoTip label={stepName} className="-ml-1">
        {holdHint(stepName)}
      </InfoTip>
    </>
  );

  /** A Step's Tasks: its tokens, the faint count of those outside the scope, Subtasks still to come. */
  const tasksAt = (id: string) => {
    const list = at.get(id) ?? [];
    const n = hidden?.get(id) ?? 0;
    const g = (ghosts ?? []).filter((x) => x.stepId === id);
    const past = stays.get(id);
    if (trace) {
      const current = trace.current === id;
      const last = trace.stays.at(-1);
      return (
        <>
          {past && (
            <span className="flex flex-col items-start gap-0.5">
              <Token task={{ ...(tasks[0] ?? { id: "p", key: "", title: "", kind: "work", blockers: [] }), holder: past.holder, blockers: [] }} hold={false} now={now} past={{ text: spanText(past.worked) }} noKey />
              {past.waited > 60_000 && <span className="text-[11px] text-muted-foreground">waited {spanText(past.waited)}</span>}
            </span>
          )}
          {current && list[0] && (
            <span className="flex flex-col items-start gap-0.5">
              {token(list[0])}
              {last && last.waited > 60_000 && <span className="text-[11px] text-muted-foreground">waited {spanText(last.waited)}</span>}
              {trace.waitsFor && (
                <span aria-hidden className="text-[11px] whitespace-nowrap text-muted-foreground">
                  {trace.waitsFor}
                </span>
              )}
            </span>
          )}
          {n > 0 && <span className="text-[11px] text-muted-foreground">+{n}</span>}
        </>
      );
    }
    return (
      <>
        {list.map(token)}
        {id === DONE_STATION && done?.map((d) => <Token key={d.id} task={{ id: d.id, key: d.key, title: d.title, kind: "work", blockers: [], done: true }} hold={false} now={now} />)}
        {g.map((x) => (
          <GhostToken key={x.label} text={x.text} label={x.label} />
        ))}
        {n > 0 && <HiddenCount n={n} />}
      </>
    );
  };

  /** What a traced Task can do next from where it is: "pass ↓ Review · fail ↩ Build". */
  const nextWords = (id: string, line: readonly string[]) =>
    trace?.current === id && trace.next.length > 0 ? (
      <div className="text-[11px] font-semibold text-state-claimed">
        {trace.next
          .map((cid) => facts.connectors.find((c) => c.id === cid))
          .filter((c): c is LineConnector => !!c)
          .map((c) => {
            const back = c.to !== null && line.indexOf(c.to) >= 0 && line.indexOf(c.to) < line.indexOf(id);
            return `${c.name} ${back ? "↩" : "↓"} ${name(c.to)}`;
          })
          .join(" · ")}
      </div>
    ) : null;

  // ---- Also starts here: the Steps before the start, the breakdown Step, the parked holds.
  const sideIds = (() => {
    const ids = new Set([...lead, ...(t.before ? [t.before] : []), ...t.holds]);
    return facts.steps.filter((s) => ids.has(s.id)).map((s) => s.id);
  })();
  const sideMarks = (id: string): ReactNode[] => {
    const s = steps.get(id);
    if (!s) return [];
    if (id === t.before) {
      return [
        ...chipsAt(t, id)
          .filter((c) => c.kind === "chip")
          .map((c) => mark(c.connector.to === null ? "done" : "chip", c.connector.id, said(c.connector, name(c.connector.to)), breakdownOutcomeHint(c.connector, name, start), { "data-connector": c.connector.id })),
        ...t.exits.filter((e) => e.stepId === id).map((e) => mark("exit", e.connector.id, said(e.connector, fullName(e.connector.to)), e.hint, { "data-connector": e.connector.id, "data-chip": "exit", "data-exit": e.connector.id })),
        mark("files", "files", start ?? FILES_LABEL, filesHint(s.name, start)),
      ];
    }
    if (t.holds.includes(id)) return [mark("hand", "hand", start ?? HAND_LABEL, holdHint(s.name))];
    // A Step before the start: its outcomes in words, a hold's moved on by hand.
    const out: ReactNode[] = [];
    for (const c of t.connectors.values()) {
      if (c.from !== id) continue;
      const kind: MarkKind = c.to === null ? "done" : isHoldStep(s) ? "hand" : "chip";
      // A hold's Connector names where a move by hand lands by default (D5): its hover is the hold's.
      out.push(mark(kind, c.id, said(c, name(c.to)), kind === "hand" ? holdHint(s.name) : outcomeHint(c, fullName), { "data-connector": c.id }));
    }
    for (const e of t.exits.filter((x) => x.stepId === id)) out.push(mark("exit", e.connector.id, said(e.connector, fullName(e.connector.to)), e.hint, { "data-connector": e.connector.id, "data-chip": "exit", "data-exit": e.connector.id }));
    return out;
  };
  const group = sideIds.length > 0 && (
    <div className="flex w-full min-w-0 basis-full items-start @3xl:basis-auto">
      <span aria-hidden className="relative mt-3 mr-2 hidden h-[1.5px] w-7 flex-none bg-muted-foreground @3xl:block">
        <span className="absolute top-[-4px] left-[-2px] border-y-[4.5px] border-r-[7px] border-y-transparent border-r-muted-foreground" />
      </span>
      <section aria-label={ALSO_LABEL} className="min-w-0 flex-1 rounded-md border px-2.5 pt-1 pb-1.5">
        <div className="text-[11px] font-medium text-muted-foreground">{ALSO_LABEL}</div>
        <div className="flex flex-col gap-1">
          {sideIds.map((id) => {
            const s = steps.get(id)!;
            const hold = isHoldStep(s);
            const list = at.get(id) ?? [];
            const n = hidden?.get(id) ?? 0;
            return (
              <div key={id} data-side={id} data-head={s.name} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span {...hover(hold ? holdHint(s.name) : undefined)} className="text-[13px] font-medium">
                  {s.name}
                </span>
                {hold ? (
                  holdPill(s.name)
                ) : id === t.before ? (
                  <InfoTip label={s.name} className="-ml-1">
                    {filesHint(s.name, start)}
                  </InfoTip>
                ) : null}
                {!hold && facts1(s, true)}
                {(!trace || trace.current === id) && list.map(token)}
                {n > 0 && <HiddenCount n={n} />}
                {entryChips(id)}
                {sideMarks(id)}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );

  // ---- The main rail.
  const mainSegs: Seg[] = rail.slice(0, -1).map((from, i) => {
    const s = t.segments.find((x) => x.from === from && x.to === rail[i + 1]);
    return s ? { from, to: s.to, connector: s.connector, hand: s.hand } : { from, to: rail[i + 1] };
  });
  const carried = new Set([...mainSegs.flatMap((s) => (s?.connector ? [s.connector.id] : [])), ...mainTracks.flatMap((k) => k.connectors.map((c) => c.id))]);
  const first = rail[0];
  const startHint = first === DONE_STATION ? undefined : t.start === first ? entryHint(name(first)) : arriveHint(name(first));
  const startRow = first !== DONE_STATION && (
    <div data-start-row className="flex min-h-6 flex-wrap items-center gap-x-2.5 gap-y-1 pb-0.5">
      <span data-start-label {...hover(startHint)} className="inline-flex items-center gap-1.5 text-[13px] font-semibold">
        <span aria-hidden>↓</span>
        {START_LABEL}
      </span>
      {entryChips(first)}
    </div>
  );

  // The Retrospective a Parent's end files, where this Workflow does not hold the Project's retro Step.
  const retro = (() => {
    if (facts.drawn === undefined || facts.steps.some((s) => s.workflow_id === facts.drawn && s.skill?.name === "retro")) return undefined;
    const s = facts.steps.find((x) => x.skill?.name === "retro");
    const w = s && facts.workflows.find((x) => x.id === s.workflow_id);
    return s && w ? `${w.name} › ${s.name}` : undefined;
  })();

  const returns = (id: string, list: readonly LaneTrack[], line: readonly string[]) =>
    list.flatMap((k) =>
      k.connectors
        .filter((c) => c.from === id)
        .map((c) => {
          const back = line.indexOf(k.target) < line.indexOf(id);
          const lit = tone([c.id]);
          return (
            <span
              key={c.id}
              data-return={c.id}
              data-connector={c.id}
              data-lit={lit === "lit" || lit === "trace" ? "true" : undefined}
              {...hover(outcomeHint(c, fullName))}
              className={cn("px-0.5 py-1 text-xs whitespace-nowrap", (lit === "trace" || lit === "lit") && "font-semibold text-state-claimed", lit === "changed" && "font-medium text-ring")}
            >
              <span aria-hidden className="mr-[3px] font-semibold text-muted-foreground">
                {back ? "↩" : "↪"}
              </span>{" "}
              {c.name} → {name(k.target)}
            </span>
          );
        }),
    );

  const mainRow = (id: string, i: number) => {
    const terminal = id === DONE_STATION;
    const s = steps.get(id);
    return {
      name: terminal ? (
        <>
          <span className="text-sm font-semibold">Done</span>
          {!trace && doneToday !== undefined && <span className="text-xs text-muted-foreground">{doneToday} today</span>}
        </>
      ) : (
        <>
          <span className="text-sm font-semibold">{s?.name}</span>
          {s && isHoldStep(s) && holdPill(s.name)}
          {facts1(s)}
        </>
      ),
      tasks: tasksAt(id),
      marks: (
        <>
          {i > 0 && entryChips(id)}
          {returns(id, mainTracks, rail)}
          {!terminal && leaves(id, carried)}
          {!trace && terminal && retro && mark("exit", "retro", retro, retroHint(retro), { "data-retro": true })}
          {nextWords(id, rail)}
          {i === 0 && group}
        </>
      ),
    };
  };

  // ---- When a Parent ends: the branch's Steps as a quiet line of their own.
  const quietStations = [...t.rows.flatMap((r) => r.stations), DONE_STATION];
  const quietSegs: Seg[] = quietStations.slice(0, -1).map((from, i) => {
    const to = quietStations[i + 1];
    const row = t.rows.find((r) => r.stations.includes(from))!;
    const k = row.stations.indexOf(from);
    if (to === DONE_STATION) return row.exit ? { from, to, connector: row.exit } : null;
    if (k === row.stations.length - 1) return null;
    const seg = row.segments.find((x) => x.lo === k);
    return { from, to, connector: seg?.connector };
  });
  const lastRow = t.rows.at(-1);
  const quietTracks = useMemo(() => laneTracks(quietStations, t.rows.flatMap((r) => r.loops.map((l) => l.connector)), new Set()), [t]); // eslint-disable-line react-hooks/exhaustive-deps
  const quietRow = (id: string) => {
    const terminal = id === DONE_STATION;
    const s = steps.get(id);
    const row = t.rows.find((r) => r.stations.includes(id));
    // An exit into Done of a row the quiet line does not end on: a mark.
    const exit = row && row !== lastRow && row.exit;
    return {
      name: <span className="text-[13px] font-medium text-muted-foreground">{terminal ? "Done" : s?.name}</span>,
      tasks: terminal ? null : tasksAt(id),
      marks: terminal ? null : (
        <>
          {entryChips(id)}
          {returns(id, quietTracks, quietStations)}
          {chipsAt(t, id).filter((c) => c.kind !== "entry").map((c) => mark(c.kind === "exit" ? "exit" : c.connector.to === null ? "done" : "chip", c.connector.id, said(c.connector, fullName(c.connector.to)), c.hint, { "data-connector": c.connector.id, "data-chip": c.kind, "data-exit": c.kind === "exit" ? c.connector.id : undefined }))}
          {exit && mark("done", exit.id, said(exit, "Done"), outcomeHint(exit, fullName), { "data-connector": exit.id })}
          {nextWords(id, quietStations)}
        </>
      ),
    };
  };
  const heading = branchLabel === AFTER_BRANCH ? AFTER_LABEL : branchLabel;
  const branch = !noBranch && t.rows.length > 0 && (
    <section aria-label={heading} className="mt-3 border-t pt-2">
      <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
        {heading}
        <InfoTip label={heading}>{AFTER_HINT}</InfoTip>
      </div>
      <RailLine
        label={heading}
        quiet
        stations={quietStations}
        segs={quietSegs}
        tracks={quietTracks}
        row={quietRow}
        hover={hover}
        name={name}
        tone={tone}
        holdAt={() => false}
        isStart={() => false}
        measureKey={[tasks, t, trace]}
      />
    </section>
  );

  return (
    <div data-line-root className="@container relative flex min-w-0 flex-col">
      <RailLine
        label="Steps on the line"
        stations={rail}
        segs={mainSegs}
        tracks={mainTracks}
        before={startRow}
        row={mainRow}
        hover={hover}
        name={name}
        tone={tone}
        holdAt={(id) => {
          const s = steps.get(id);
          return !!s && isHoldStep(s);
        }}
        isStart={(id) => id === first && id !== DONE_STATION}
        visited={(id) => !!trace?.stays.some((x) => x.stepId === id)}
        travelling={flow.tokens}
        outcomeOf={(id) => facts.connectors.find((c) => c.id === id)?.name}
        measureKey={[tasks, t, trace, done, ghosts, hidden]}
      />
      {branch}
      {footer}
      {tip && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-30 w-max max-w-[320px] rounded-md border bg-popover px-2.5 py-1.5 text-xs leading-[18px] text-popover-foreground shadow-pop"
          style={{ left: Math.max(8, Math.min(tip.x + 12, tip.w - 330)), top: tip.y + 16 }}
        >
          {tip.text}
        </div>
      )}
    </div>
  );
}

/**
 * One rail and its rows: the stations in order (Done last), a segment between each pair with its
 * outcome's name under the station it leaves and an arrowhead into the next, tracks in lanes
 * between the rail and the rows. Drawn in SVG from where each row's station is measured to stand.
 */
function RailLine({
  label,
  quiet,
  stations,
  segs,
  tracks,
  before,
  row,
  hover,
  name,
  tone,
  holdAt,
  isStart,
  visited,
  travelling,
  outcomeOf,
  measureKey,
}: {
  label: string;
  quiet?: boolean;
  stations: readonly string[];
  segs: readonly Seg[];
  tracks: readonly LaneTrack[];
  before?: ReactNode;
  row: (id: string, i: number) => { name: ReactNode; tasks: ReactNode; marks: ReactNode };
  hover: Hover;
  name: (id: string | null) => string;
  tone: (ids: readonly string[]) => Tone;
  holdAt: (id: string) => boolean;
  isStart: (id: string) => boolean;
  visited?: (id: string) => boolean;
  /** The tokens travelling now, carried along this rail: by their Connector, by hand along it, or off it. */
  travelling?: readonly FlowToken[];
  outcomeOf?: (connectorId: string) => string | undefined;
  measureKey: unknown[];
}) {
  const box = useRef<HTMLDivElement>(null);
  const dots = useRef(new Map<string, HTMLElement>());
  const [ys, setYs] = useState<Map<string, number>>(new Map());
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const measure = () => {
      if (!box.current) return;
      const top = box.current.getBoundingClientRect().top;
      const m = new Map<string, number>();
      for (const [id, el] of dots.current) {
        const r = el.getBoundingClientRect();
        m.set(id, r.top - top + r.height / 2);
      }
      setYs((was) => (was.size === m.size && [...m].every(([k, v]) => was.get(k) === v) ? was : m));
      setHeight(box.current.getBoundingClientRect().height);
    };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    if (box.current) ro?.observe(box.current);
    return () => ro?.disconnect();
  }, measureKey); // eslint-disable-line react-hooks/exhaustive-deps

  const lanes = tracks.length;
  const lanesW = lanes ? LANE0 + lanes * LANE : 0;
  const bodyLeft = 22 + lanesW + 8;
  const laneX = (lane: number) => 22 + 4 + lane * LANE;
  const ink = quiet ? "var(--muted-foreground)" : "var(--foreground)";
  const weight = quiet ? 1.5 : 2;
  const radius = (id: string) => (isStart(id) ? 9 : quiet ? 4.5 : id === DONE_STATION ? 6 : 5.5);
  const y = (id: string) => ys.get(id);
  const stroke = (t: Tone, plain = ink) => (t === "trace" || t === "next" || t === "lit" ? "var(--state-claimed)" : t === "changed" ? "var(--ring)" : plain);

  const svgRail = segs.map((s) => {
    if (!s) return null;
    const [a, b] = [y(s.from), y(s.to)];
    if (a === undefined || b === undefined) return null;
    const ids = s.connector ? [s.connector.id] : [];
    const tn = tone(ids);
    const top = a + radius(s.from) + 1;
    const tip = b - radius(s.to) - 1;
    const gap = !s.connector && !s.hand;
    const col = gap ? "var(--border)" : s.hand ? "var(--muted-foreground)" : stroke(tn);
    const hint = s.connector ? undefined : s.hand ? handHint(name(s.from), name(s.to)) : gapHint(name(s.from), name(s.to));
    return (
      <g key={s.from}>
        <path data-rail={s.from} data-gap={gap ? "true" : undefined} d={`M${RAIL} ${top} V${tip - (gap ? 0 : 6)}`} stroke={col} strokeWidth={tn === "trace" ? 4 : weight} strokeDasharray={gap ? "2 5" : s.hand ? "3 3" : tn === "next" ? "5 4" : undefined} fill="none" />
        {!gap && <path data-arrow={s.from} d={`M${RAIL - 4.5} ${tip - 7} L${RAIL} ${tip} L${RAIL + 4.5} ${tip - 7} Z`} fill={col} />}
        <path
          {...hover(s.connector ? outcomeHint(s.connector, name) : hint)}
          data-connector={s.connector?.id}
          d={`M${RAIL} ${top} V${tip}`}
          stroke="transparent"
          strokeWidth={12}
          fill="none"
          style={{ pointerEvents: "stroke" }}
        />
      </g>
    );
  });

  const svgTracks = tracks.map((k) => {
    const pts = k.ends.map((e) => {
      const v = y(stations[e.at]);
      return v === undefined ? undefined : v + e.dy * STUB;
    });
    if (pts.some((p) => p === undefined)) return <g key={k.target} data-track={k.target} data-lane={k.lane} />;
    const x = laneX(k.lane);
    const tn = tone(k.connectors.map((c) => c.id));
    const col = stroke(tn);
    const lo = Math.min(...(pts as number[]));
    const hi = Math.max(...(pts as number[]));
    return (
      <g key={k.target} data-track={k.target} data-lane={k.lane}>
        <path d={`M${x} ${lo} V${hi}`} stroke={col} strokeWidth={1.5} fill="none" strokeDasharray={tn === "next" ? "3 3" : undefined} />
        {k.ends.map((e, i) => {
          const v = pts[i]!;
          const edge = RAIL + radius(stations[e.at]) + 1;
          const into = e.connectors.length === 0;
          return (
            <g key={`${e.at}:${i}`}>
              <path d={`M${into ? edge + 6 : edge} ${v} H${x}`} stroke={col} strokeWidth={1.5} fill="none" />
              {into && <path data-arrow-in={k.target} d={`M${edge + 7} ${v - 4.5} L${edge} ${v} L${edge + 7} ${v + 4.5} Z`} fill={col} />}
              <path
                {...hover(into ? outcomesHint(k.connectors, name) : outcomesHint(e.connectors, name))}
                data-connectors={JSON.stringify((into ? k.connectors : e.connectors).map((c) => c.id))}
                d={`M${edge} ${v} H${x}`}
                stroke="transparent"
                strokeWidth={10}
                fill="none"
                style={{ pointerEvents: "stroke" }}
              />
            </g>
          );
        })}
      </g>
    );
  });

  const svgDots = stations.map((id) => {
    const v = y(id);
    if (v === undefined) return null;
    const terminal = id === DONE_STATION;
    const start = isStart(id);
    const hold = holdAt(id);
    return (
      <circle
        key={id}
        data-dot={id}
        data-start={start ? "" : undefined}
        cx={RAIL}
        cy={v}
        r={radius(id)}
        fill={terminal ? (quiet ? "var(--muted-foreground)" : "var(--state-done)") : start ? (quiet ? "var(--background)" : ink) : "var(--background)"}
        stroke={terminal ? (quiet ? "var(--muted-foreground)" : "var(--state-done)") : visited?.(id) ? "var(--state-claimed)" : hold ? "var(--muted-foreground)" : ink}
        strokeWidth={terminal || start ? 0 : weight}
        strokeDasharray={hold ? "3 2.5" : undefined}
      />
    );
  });

  // A move along the rail: its segment, its track, straight down by hand, or off the line to the right.
  const routeOf = (tk: FlowToken): string | undefined => {
    if (tk.travel.to === DROPPED) return undefined;
    const to = tk.travel.to === DONE ? DONE_STATION : tk.travel.to;
    const [a, b] = [y(tk.travel.from), y(to)];
    if (a === undefined) return undefined;
    const id = tk.travel.connectorId;
    const track = id ? tracks.find((k) => k.connectors.some((c) => c.id === id)) : undefined;
    if (track && b !== undefined) {
      const from = track.ends.find((e) => e.connectors.some((c) => c.id === id))!;
      const into = track.ends.find((e) => e.connectors.length === 0)!;
      return `M${RAIL} ${a + from.dy * STUB} H${laneX(track.lane)} V${b + into.dy * STUB} H${RAIL}`;
    }
    if (b !== undefined) return `M${RAIL} ${a} V${b}`;
    return `M${RAIL} ${a} H${bodyLeft + 160}`;
  };
  const moving = (travelling ?? [])
    .map((tk) => {
      const route = routeOf(tk);
      return route ? { tk, route, outcome: tk.travel.connectorId ? outcomeOf?.(tk.travel.connectorId) : HAND_LABEL } : undefined;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);

  return (
    <div className="flex flex-col">
      {before && <div style={{ paddingLeft: bodyLeft }}>{before}</div>}
      <div ref={box} className="relative">
        <svg aria-hidden className="pointer-events-none absolute top-0 left-0 overflow-visible" width={bodyLeft} height={Math.max(1, height)}>
          {svgRail}
          {svgTracks}
          {svgDots}
        </svg>
        <ol aria-label={label} className="relative flex flex-col">
          {stations.map((id, i) => {
            const r = row(id, i);
            const s = segs[i];
            const hold = holdAt(id);
            return (
              <li key={id} data-station={id} data-head={name(id)} data-start={isStart(id) ? "" : undefined} data-hold={hold ? "" : undefined} className="relative" style={{ paddingLeft: bodyLeft }}>
                <span
                  aria-hidden
                  ref={(el) => {
                    if (el) dots.current.set(id, el);
                    else dots.current.delete(id);
                  }}
                  className="absolute top-[7px] left-0 h-[14px] w-[22px]"
                />
                <div className="grid min-w-0 grid-cols-1 items-start gap-x-6 gap-y-1 @3xl:grid-cols-[minmax(0,300px)_minmax(0,300px)_minmax(0,1fr)]">
                  <div className="flex min-h-7 min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">{r.name}</div>
                  <div className="flex min-w-0 flex-wrap items-center gap-1 empty:hidden @3xl:empty:flex">{r.tasks}</div>
                  <div className="flex min-w-0 flex-wrap items-center gap-1 empty:hidden">{r.marks}</div>
                </div>
                {s ? (
                  <div
                    data-segment={s.from}
                    data-connector={s.connector?.id}
                    data-lit={s.connector && ["lit", "trace"].includes(tone([s.connector.id])) ? "true" : undefined}
                    {...hover(s.connector ? outcomeHint(s.connector, name) : s.hand ? handHint(name(s.from), name(s.to)) : undefined)}
                    className={cn("w-max pt-1 pb-2 text-xs text-muted-foreground", !s.connector && !s.hand && "h-5", ["trace", "lit"].includes(tone(s.connector ? [s.connector.id] : [])) && "font-semibold text-state-claimed")}
                  >
                    {s.connector ? s.connector.name : s.hand ? HAND_LABEL : ""}
                  </div>
                ) : (
                  i < stations.length - 1 && <div className="h-4" />
                )}
              </li>
            );
          })}
        </ol>
        {moving.map(({ tk, route, outcome }) => (
          <div key={tk.id} className="wl-travel pointer-events-none absolute top-0 left-0 z-10" style={{ offsetPath: `path("${route}")` }} data-travel={tk.key}>
            <span className={cn("wl-token inline-flex h-[26px] items-center gap-1.5 rounded-full border-[1.5px] bg-background px-2.5 text-xs whitespace-nowrap shadow-pop", !tk.travel.connectorId && "border-dashed")} data-state="waiting">
              <span className="font-mono text-[11.5px]">{tk.key}</span>
              {outcome && <span className="text-muted-foreground">{outcome}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
