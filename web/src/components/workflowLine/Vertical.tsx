import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MemberAvatar } from "@/components/MemberAvatar";
import type { FlowState } from "@/components/workflow/live";
import { cn } from "@/lib/utils";
import type { Ghost, Trace } from "./data";
import { arrowhead } from "./draw";
import { BRACKET_OFF, bracketX, brackets, railX, type LineTopology } from "./layout";
import { DONE_STATION, isHoldStep, type LineFacts, type LineTask } from "./model";
import { spanText } from "@/lib/time";
import { GhostToken, HiddenCount, Token } from "./Token";
import { BREAKDOWN_BRANCH, entryHint, ENTRY_LABEL, FILES_LABEL, filesHint, HAND_LABEL, holdHint, HOLD_NOTE } from "./words";

/**
 * The line turned to run down a phone: stations as rows, a Step's tokens wrapping beside its name,
 * loops back as brackets left of the rail, forward skips and side exits as chips; the branch
 * "After a Parent" as rows of its own below. Above the rail, where Tasks enter: the branch
 * "Break down", the parked holds, and "New Tasks start here" into the start Step.
 */
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
  compactHeads,
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
  compactHeads?: boolean;
  noBranch?: boolean;
  footer?: ReactNode;
}) {
  const steps = useMemo(() => new Map(facts.steps.map((s) => [s.id, s])), [facts.steps]);
  const rail = useMemo(() => railX(t), [t]);
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
      setYs(m);
      setHeight(box.current.getBoundingClientRect().height);
    };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    if (box.current) ro?.observe(box.current);
    return () => ro?.disconnect();
  }, [tasks, t, trace]);

  const at = new Map<string, LineTask[]>();
  for (const task of tasks) if (task.stepId && !flow.transit.has(task.id)) at.set(task.stepId, [...(at.get(task.stepId) ?? []), task]);
  for (const list of at.values()) list.sort((a, b) => Number(!!b.holder) - Number(!!a.holder) || (a.since ?? 0) - (b.since ?? 0));

  const traversed = new Set(trace?.traversed ?? []);
  const name = (id: string | null) => (id === null ? "Done" : (steps.get(id)?.name ?? "a Step"));
  const chipsAt = (id: string): { text: string; exit?: string; hint?: string }[] => [
    ...t.over.filter((a) => !a.back && a.connector.from === id).map((a) => ({ text: `${a.connector.name} → ${name(a.connector.to)}` })),
    ...t.chips.filter((c) => c.stepId === id).map((c) => ({ text: c.text })),
    // Its outcomes into other Workflows, as across.
    ...t.exits.filter((c) => c.stepId === id).map((c) => ({ text: c.text, exit: c.connector.id, hint: c.hint })),
    // Neighbours no Connector joins, where the first has no outcome on: a human moves a Task on.
    // Where its outcomes lead elsewhere nothing moves between them, and nothing is said.
    ...t.segments.filter((s) => s.from === id && s.hand).map((s) => ({ text: `${HAND_LABEL} → ${name(s.to === DONE_STATION ? null : s.to)}` })),
  ];
  const entry = t.start !== undefined && t.main[0] === t.start;
  // Where Tasks arrive from other Workflows: a mark on each Step they reach.
  const arrivals = new Map<string, LineTopology["entries"]>();
  for (const e of t.entries) arrivals.set(e.stepId, [...(arrivals.get(e.stepId) ?? []), e]);
  const stays = new Map((trace?.stays ?? []).filter((s) => s.until !== undefined).map((s) => [s.stepId, s]));

  const token = (task: LineTask) => (
    <Token
      key={task.id}
      task={task}
      hold={!!task.stepId && !!steps.get(task.stepId) && isHoldStep(steps.get(task.stepId)!)}
      now={now}
      selected={selected === task.id}
      ringed={!!ringed?.has(task.id)}
      pulse={flow.pulses.get(task.id)}
      arrived={flow.arrived.has(task.id)}
      onClick={onSelect ? () => onSelect(selected === task.id ? null : task.id) : onOpenTask && (() => onOpenTask(task.key))}
      noKey={!!trace}
    />
  );

  const row = (id: string, i: number) => {
    const s = steps.get(id);
    const terminal = id === DONE_STATION;
    const list = at.get(id) ?? [];
    const n = hidden?.get(id) ?? 0;
    const past = stays.get(id);
    const chips = trace ? [] : chipsAt(id);
    const current = trace?.current === id;
    const right = terminal ? (doneToday !== undefined ? `${doneToday} today` : "") : !s ? "" : isHoldStep(s) ? "hold" : s.medianMs !== undefined ? `median ${spanText(s.medianMs)}` : "";
    return (
      <li key={id} className="relative pr-0.5 pb-3" style={{ paddingLeft: rail + 10 }}>
        <span
          aria-hidden
          ref={(el) => {
            if (el) dots.current.set(id, el);
            else dots.current.delete(id);
          }}
          className="absolute top-[3px] size-[14px]"
          style={{ left: rail - 7 }}
        />
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate font-semibold">{terminal ? "Done" : s?.name}</span>
          {s?.skill && <span className="truncate font-mono text-[11px] text-muted-foreground">{s.skill.name}</span>}
          {(compactHeads || !!trace) && n > 0 && <span className="text-[11px] text-muted-foreground">+{n}</span>}
          {!trace && right && <span className="ml-auto flex-none text-[11px] text-muted-foreground">{right}</span>}
          {past && (
            <span className="ml-auto flex flex-none flex-col items-end gap-0.5">
              <Token task={{ ...(tasks[0] ?? { id: "p", key: "", title: "", kind: "work", blockers: [] }), holder: past.holder, blockers: [] }} hold={false} now={now} past={{ text: spanText(past.worked) }} noKey />
              {past.waited > 60_000 && <span className="text-[11px] text-muted-foreground">waited {spanText(past.waited)}</span>}
            </span>
          )}
          {current && list[0] && (
            <span className="ml-auto flex flex-none flex-col items-end gap-0.5">
              {token(list[0])}
              {trace?.stays.at(-1) && trace.stays.at(-1)!.waited > 60_000 && <span className="text-[11px] text-muted-foreground">waited {spanText(trace.stays.at(-1)!.waited)}</span>}
            </span>
          )}
        </div>
        {!trace && !entry && id === t.start && (
          <span title={entryHint(s?.name ?? "")} data-entry-mark className="mt-1 inline-flex rounded-full border px-1.5 text-[10.5px] leading-4 font-medium">
            New Tasks start here, at {s?.name}
          </span>
        )}
        {!trace && arrivals.has(id) && (
          <div className="mt-1 flex flex-wrap gap-1">
            {arrivals.get(id)!.map((e) => (
              <span key={e.connector.id} title={e.hint} data-arrival={id} className="inline-flex rounded-full border px-1.5 text-[10.5px] leading-4 font-medium">
                {e.text}
              </span>
            ))}
          </div>
        )}
        {!trace && (list.length > 0 || n > 0 || (terminal && (done?.length ?? 0) > 0)) && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {list.map(token)}
            {terminal && done?.map((d) => <Token key={d.id} task={{ id: d.id, key: d.key, title: d.title, kind: "work", blockers: [], done: true }} hold={false} now={now} />)}
            {!compactHeads && n > 0 && <HiddenCount n={n} />}
          </div>
        )}
        {chips.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {chips.map((c) => (
              <span key={c.text} data-exit={c.exit} title={c.hint} className="rounded-full border border-dashed px-1.5 text-[10.5px] leading-4 text-muted-foreground">
                {c.text}
              </span>
            ))}
          </div>
        )}
        {current && trace && trace.next.length > 0 && (
          <div className="mt-1 text-[11px] font-semibold text-state-claimed">
            {trace.next
              .map((cid) => facts.connectors.find((c) => c.id === cid))
              .filter((c): c is NonNullable<typeof c> => !!c)
              .map((c) => {
                const back = c.to !== null && t.main.indexOf(c.to) >= 0 && t.main.indexOf(c.to) < i;
                return `${c.name} ${back ? "↩" : "↓"} ${name(c.to)}`;
              })
              .join(" · ")}
          </div>
        )}
      </li>
    );
  };

  // The rail and its brackets, once the rows are measured.
  const y = (id: string) => ys.get(id);
  const segs = t.segments.map((s) => {
    const [a, b] = [y(s.from), y(s.to)];
    if (a === undefined || b === undefined) return null;
    const tone = s.connector && traversed.has(s.connector.id) ? "trace" : trace && s.connector && trace.next.includes(s.connector.id) ? "next" : "plain";
    return (
      <line
        key={s.from}
        x1={rail}
        y1={a}
        x2={rail}
        y2={b}
        data-gap={!s.connector && !s.hand ? "true" : undefined}
        stroke={!s.connector ? (s.hand ? "var(--muted-foreground)" : "var(--border)") : tone === "plain" ? "var(--foreground)" : "var(--state-claimed)"}
        strokeWidth={!s.connector ? 1.5 : tone === "trace" ? 4 : 3}
        strokeDasharray={!s.connector ? "2 5" : tone === "next" ? "5 4" : undefined}
      />
    );
  });
  const marks = brackets(t).map((b) => {
    const [lo, hi] = [y(t.main[b.lo]), y(t.main[b.hi])];
    if (lo === undefined || hi === undefined) return null;
    const x = bracketX(rail, b.depth);
    const tone = traversed.has(b.connector.id) ? "trace" : trace?.next.includes(b.connector.id) ? "next" : trace ? "dim" : "plain";
    const col = tone === "trace" || tone === "next" ? "var(--state-claimed)" : "var(--muted-foreground)";
    return (
      <g key={b.connector.id} className={cn(tone === "dim" && "opacity-40")}>
        <path data-track={x} d={`M${rail - 6} ${hi - 3} H${x + 4} Q${x} ${hi - 3} ${x} ${hi - 7} V${lo + 7} Q${x} ${lo + 3} ${x + 4} ${lo + 3} H${rail - BRACKET_OFF}`} fill="none" stroke={col} strokeWidth={1.4} strokeDasharray={tone === "next" ? "3 3" : undefined} />
        <path d={arrowhead(rail - BRACKET_OFF, lo + 3, "right")} fill="none" stroke={col} strokeWidth={1.4} />
      </g>
    );
  });

  const branch = !noBranch && t.rows.length > 0 && (
    <section aria-label={branchLabel} className="mt-1 border-t px-3.5 pt-2.5 pb-1">
      <div className="mb-1.5 text-[11px] text-muted-foreground">{branchLabel}</div>
      <ul className="flex flex-col">
        {t.rows.flatMap((r) => r.stations).map((id) => {
          const s = steps.get(id);
          if (!s) return null;
          const list = at.get(id) ?? [];
          const takers = s.takers ?? [];
          const paused = takers.length > 0 && takers.every((m) => m.paused);
          const g = (ghosts ?? []).filter((x) => x.stepId === id);
          return (
            <li key={id} className="flex min-h-8 flex-wrap items-center gap-1.5 py-0.5">
              <span aria-hidden className="size-3.5 rounded-full border-[1.5px] border-foreground" />
              <b className="font-semibold">{s.name}</b>
              {paused ? <span className="rounded-full border px-1.5 text-[10.5px] leading-4 text-muted-foreground">paused</span> : s.skill && <span className="font-mono text-[11px] text-muted-foreground">{s.skill.name}</span>}
              {!paused && takers.slice(0, 1).map((m) => <MemberAvatar key={m.id} member={m} working={m.working} />)}
              <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                {list.length === 0 && g.length === 0 && <span className="text-[11px] text-muted-foreground">0 Tasks</span>}
                {list.map(token)}
                {g.map((x) => (
                  <GhostToken key={x.label} text={x.text} label={x.label} />
                ))}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );

  // Where Tasks enter, above the rail: the branch Break down, the parked holds, and the entry into the start Step.
  const sideRow = (id: string, hold: boolean) => {
    const s = steps.get(id);
    if (!s) return null;
    const list = at.get(id) ?? [];
    const takers = s.takers ?? [];
    const n = hidden?.get(id) ?? 0;
    return (
      <li key={id} title={hold ? holdHint(s.name) : undefined} className="flex min-h-8 flex-wrap items-center gap-1.5 py-0.5">
        <span aria-hidden className={cn("size-3.5 rounded-full border-[1.5px] border-foreground", hold && "border-dashed")} />
        <b className="font-semibold">{s.name}</b>
        {hold ? <span className="text-[11px] text-muted-foreground">{HOLD_NOTE}</span> : s.skill && <span className="font-mono text-[11px] text-muted-foreground">{s.skill.name}</span>}
        {!hold && takers.slice(0, 1).map((m) => <MemberAvatar key={m.id} member={m} working={m.working} />)}
        <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          {!trace && list.map(token)}
          {!compactHeads && n > 0 && <HiddenCount n={n} />}
        </span>
      </li>
    );
  };
  const before = t.before;
  const start = t.start !== undefined ? name(t.start) : undefined;
  const enter = (before || t.holds.length > 0 || entry) && (
    <section aria-label="Where Tasks enter" className="flex flex-col gap-1 border-b px-3.5 pt-2 pb-2.5">
      {before && (
        <div>
          <div className="text-[11px] text-muted-foreground">{BREAKDOWN_BRANCH}</div>
          <ul className="flex flex-col">{sideRow(before, false)}</ul>
          <div title={filesHint(name(before), start)} className="flex flex-wrap gap-1 pl-5">
            {start && <span className="rounded-full border border-dashed px-1.5 text-[10.5px] leading-4 text-muted-foreground">{FILES_LABEL}</span>}
            {[...t.chips, ...t.exits]
              .filter((c) => c.stepId === before)
              .map((c) => (
                <span key={c.connector.id} data-exit={"hint" in c ? c.connector.id : undefined} className="rounded-full border border-dashed px-1.5 text-[10.5px] leading-4 text-muted-foreground">
                  {c.text}
                </span>
              ))}
          </div>
        </div>
      )}
      {t.holds.length > 0 && <ul className="flex flex-col">{t.holds.map((id) => sideRow(id, true))}</ul>}
      {entry && start && (
        <div title={entryHint(start)} data-entry className="flex items-center gap-1.5 pt-0.5 text-[11.5px] font-medium">
          {ENTRY_LABEL}
          <span aria-hidden className="text-muted-foreground">↓</span>
          <span className="text-muted-foreground">{start}</span>
        </div>
      )}
    </section>
  );

  return (
    <div className="flex flex-col">
      {enter}
      <div ref={box} className="relative pt-3">
        <svg aria-hidden className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={Math.max(1, height)}>
          {segs}
          {marks}
          {t.main.map((id) => {
            const v = y(id);
            if (v === undefined) return null;
            const s = steps.get(id);
            const terminal = id === DONE_STATION;
            const visited = trace?.stays.some((x) => x.stepId === id);
            return (
              <circle
                key={id}
                cx={rail}
                cy={v}
                r={terminal ? 7 : 6}
                fill={terminal ? "var(--state-done)" : "var(--background)"}
                stroke={terminal ? "var(--state-done)" : visited ? "var(--state-claimed)" : "var(--foreground)"}
                strokeWidth={2.5}
                strokeDasharray={s && isHoldStep(s) ? "3 3" : undefined}
              />
            );
          })}
        </svg>
        <ol aria-label="Steps on the line" className="relative flex flex-col">
          {t.main.map(row)}
        </ol>
      </div>
      {branch}
      {footer}
    </div>
  );
}
