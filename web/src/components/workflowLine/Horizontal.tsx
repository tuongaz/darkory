import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MemberAvatar } from "@/components/MemberAvatar";
import { DONE, DROPPED, type FlowState } from "@/components/workflow/live";
import { cn } from "@/lib/utils";
import { ChainCallout } from "./Callout";
import { chainOf, type Chain, type Ghost, type Trace } from "./data";
import { arrowhead, placeCallout, smooth, type Box } from "./draw";
import { handRoute, horizontal as layOut, type Density, type DrawnArc, type Horizontal as Laid, type LineTopology } from "./layout";
import { DONE_STATION, isHoldStep, PICKUP_MS, spanTime, tokenTime, type LineFacts, type LineStepFacts, type LineTask } from "./model";
import { Bead, GhostToken, HiddenCount, Token } from "./Token";

/** How many tokens a Step's column shows before "+N more". */
export const COLUMN_CAP = 6;
const TOKEN_H = 30;
const TOKEN_GAP = 6;

export type HorizontalProps = {
  topology: LineTopology;
  facts: LineFacts;
  width: number;
  density: Density;
  tasks: readonly LineTask[];
  all: readonly LineTask[];
  hidden?: ReadonlyMap<string, number>;
  done?: readonly { id: string; key: string; title: string }[];
  ghosts?: readonly Ghost[];
  branchLabel: string;
  fold?: boolean;
  doneToday?: number;
  trace?: Trace;
  flow: FlowState;
  now: number;
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  ringed?: ReadonlySet<string>;
  onRing?: (id: string | null) => void;
  onOpenTask?: (key: string) => void;
  me: { id: string; takeable: ReadonlySet<string> };
  actionFor?: (first: Chain["first"]) => ReactNode;
  /** Station heads as names only, with "+N": a single Task's line. */
  compactHeads?: boolean;
  /** Connectors an edit changed: amber, dashed. */
  highlight?: ReadonlySet<string>;
  /** A loop lit from the Loops list. */
  litLoop?: string | null;
  noBranch?: boolean;
};

/** The line laid left to right: stations, routes, tokens and the moments playing on them. */
export function HorizontalLine(props: HorizontalProps) {
  const { topology: t, facts, width, density, tasks, all, flow, now, trace } = props;
  const box = useRef<HTMLDivElement>(null);
  const steps = useMemo(() => new Map(facts.steps.map((s) => [s.id, s])), [facts.steps]);
  const stepOf = (id: string): LineStepFacts | undefined => steps.get(id);
  const [openStep, setOpenStep] = useState<string | null>(null);

  // Each station's column, in the order the line stacks it: held first, then oldest first.
  const columns = useMemo(() => {
    const at = new Map<string, LineTask[]>();
    for (const task of tasks) {
      if (!task.stepId || flow.transit.has(task.id)) continue;
      at.set(task.stepId, [...(at.get(task.stepId) ?? []), task]);
    }
    for (const list of at.values()) list.sort((a, b) => Number(!!b.holder) - Number(!!a.holder) || (a.since ?? 0) - (b.since ?? 0));
    return at;
  }, [tasks, flow.transit]);
  const doneTokens = props.done ?? [];

  const traceStays = useMemo(() => {
    const m = new Map<string, NonNullable<Trace>["stays"][number]>();
    for (const s of trace?.stays ?? []) if (s.until !== undefined) m.set(s.stepId, s);
    return m;
  }, [trace]);

  const traceAt = trace?.current;
  // The tallest column, in px: its tokens (to the cap), a "+N more", the faint "+N", a path's notes.
  const columnPx = useMemo(() => {
    if (props.fold) return 0;
    let max = 0;
    for (const id of t.main) {
      const n = columns.get(id)?.length ?? 0;
      const shown = density === "beads" ? Math.ceil(n / 3) * 18 : Math.min(n, COLUMN_CAP) * (TOKEN_H + TOKEN_GAP) + (n > COLUMN_CAP ? 24 : 0);
      const extra = (props.hidden?.get(id) ? 24 : 0) + (traceStays.has(id) ? TOKEN_H + 22 : 0) + (traceAt === id ? 18 : 0) + (id === DONE_STATION ? doneTokens.length * (TOKEN_H + TOKEN_GAP) : 0);
      max = Math.max(max, shown + extra);
    }
    return Math.max(0, max - TOKEN_GAP);
  }, [t.main, columns, density, props.hidden, props.fold, traceStays, traceAt, doneTokens.length]);

  // A branch Step's name line, roughly: its name, Skill, marks, up to two tokens, its ghost.
  const ghosts = props.ghosts;
  const hiddenAt = props.hidden;
  const labelWidth = useCallback(
    (id: string) => {
      const s = steps.get(id);
      if (!s) return 0;
      const named = !ghosts?.length;
      const takers = s.takers ?? [];
      const paused = takers.length > 0 && takers.every((m) => m.paused);
      const here = columns.get(id) ?? [];
      return (
        s.name.length * 7.6 +
        (named && s.skill ? s.skill.name.length * 6.7 + 6 : 0) +
        (named || paused ? Math.min(2, takers.length) * 26 : 0) +
        (paused ? 58 : 0) +
        here.slice(0, 2).reduce((n, x) => n + x.key.length * 7 + 74, 0) +
        (ghosts ?? []).filter((g) => g.stepId === id).reduce((n, g) => n + g.text.length * 6.4 + 30, 0) +
        (hiddenAt?.get(id) ? 36 : 0)
      );
    },
    [steps, ghosts, columns, hiddenAt],
  );
  const h: Laid = useMemo(
    () => layOut(t, { width, density, column: props.fold ? 0 : columnPx, noBranch: props.noBranch, branchGap: ghosts?.length ? 380 : 240, labelWidth }),
    [t, width, density, columnPx, props.fold, props.noBranch, ghosts?.length, labelWidth],
  );

  const selected = props.selected ? all.find((x) => x.id === props.selected) : undefined;
  const chain = useMemo(() => (selected ? chainOf(selected.id, all, props.me) : undefined), [selected, all, props.me]);
  const inChain = useMemo(() => new Set(chain ? [chain.task.id, ...chain.upstream.flat().map((x) => x.id), ...chain.downstream.map((x) => x.id)] : []), [chain]);
  const dimOthers = !!chain;
  const dimRoutes = dimOthers || !!trace;

  const traversed = new Set(trace?.traversed ?? []);
  const next = new Set(trace?.next ?? []);
  const lit = flow.lit;
  const loopLit = (ids: string[]) => !!props.litLoop && ids.includes(props.litLoop);
  // A selection fades the loops and skips; the main line stays (`main`).
  const routeTone = (ids: string[], main = false): "trace" | "next" | "lit" | "dim" | "plain" => {
    if (ids.some((id) => traversed.has(id))) return "trace";
    if (ids.some((id) => next.has(id) || !!props.highlight?.has(id))) return "next";
    if (ids.some((id) => lit.has(id)) || loopLit(ids)) return "lit";
    return (main ? !!trace : dimRoutes) || props.fold || props.litLoop ? "dim" : "plain";
  };

  // Measured after layout: where each token sits, for the chain's rails and the callout.
  const [rects, setRects] = useState<Map<string, Box>>(new Map());
  const [calloutSize, setCalloutSize] = useState({ w: 480, h: 110 });
  const calloutRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!chain || !box.current) {
      setRects((r) => (r.size === 0 ? r : new Map()));
      return;
    }
    const origin = box.current.getBoundingClientRect();
    const m = new Map<string, Box>();
    box.current.querySelectorAll<HTMLElement>("button[data-task]").forEach((el) => {
      const r = el.getBoundingClientRect();
      m.set(el.dataset.task!, { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height });
    });
    setRects(m);
    if (calloutRef.current) {
      const c = calloutRef.current.getBoundingClientRect();
      if (c.width > 0 && (Math.abs(c.width - calloutSize.w) > 1 || Math.abs(c.height - calloutSize.h) > 1)) setCalloutSize({ w: c.width, h: c.height });
    }
  }, [chain, h, width, calloutSize.w, calloutSize.h]);

  const head = (id: string, x: number) => {
    const s = stepOf(id);
    const hidden = props.hidden?.get(id) ?? 0;
    if (id === DONE_STATION) {
      return (
        <div key={id} data-head="Done" className="absolute -translate-x-1/2 text-center" style={{ left: x, top: props.compactHeads || props.fold ? h.headY + 20 : h.headY }}>
          <div className={cn("text-[13.5px] font-semibold whitespace-nowrap", density === "beads" && "flex h-[30px] items-end justify-center text-[12.5px]")}>Done</div>
          {!props.compactHeads && density === "tokens" && <div className="mt-1 flex h-[22px] items-center justify-center text-[11.5px] text-muted-foreground">{props.doneToday !== undefined ? `${props.doneToday} today` : ""}</div>}
        </div>
      );
    }
    if (!s) return null;
    const hold = isHoldStep(s);
    const count = columns.get(id)?.length ?? 0;
    if (props.compactHeads || props.fold) {
      return (
        <div key={id} data-head={s.name} className="absolute -translate-x-1/2 text-center whitespace-nowrap" style={{ left: x, top: h.headY + 20 }}>
          <span className="text-[13px] font-semibold">{s.name}</span>
          {hidden > 0 && <span className="ml-1 text-[11px] text-muted-foreground">+{hidden}</span>}
        </div>
      );
    }
    if (density === "beads") {
      return (
        <button
          key={id}
          type="button"
          aria-expanded={openStep === id}
          aria-label={`${s.name}: ${count} ${count === 1 ? "Task" : "Tasks"}`}
          onClick={() => setOpenStep((o) => (o === id ? null : id))}
          onMouseEnter={() => count > 0 && setOpenStep(id)}
          data-head={s.name}
          className="absolute w-[84px] -translate-x-1/2 text-center"
          style={{ left: x, top: h.headY }}
        >
          <div className="flex h-[30px] items-end justify-center text-[12.5px] leading-[15px] font-semibold">{s.name}</div>
          <div className="h-[15px] font-mono text-[10.5px] text-muted-foreground">{s.skill?.name ?? (hold ? "hold" : "")}</div>
          <div className="h-[15px] text-[11px] whitespace-nowrap text-muted-foreground">
            {count} {count === 1 ? "Task" : "Tasks"}
          </div>
        </button>
      );
    }
    const takers = s.takers ?? [];
    return (
      <div key={id} data-head={s.name} className="absolute -translate-x-1/2 text-center" style={{ left: x, top: h.headY }}>
        <div className="text-[13.5px] font-semibold whitespace-nowrap">
          {s.name}
          {s.skill && <span className="ml-1 font-mono text-[11px] font-normal text-muted-foreground">{s.skill.name}</span>}
        </div>
        <div className="mt-1 flex h-[22px] items-center justify-center gap-1.5 text-[11.5px] whitespace-nowrap text-muted-foreground">
          {hold ? (
            "hold"
          ) : takers.length === 0 ? (
            "no Member"
          ) : (
            <>
              {takers.slice(0, 3).map((m) => (
                <MemberAvatar key={m.id} member={m} working={m.working} />
              ))}
              {takers.length > 3 && <span>+{takers.length - 3}</span>}
              {s.medianMs !== undefined && <span>median {spanTime(s.medianMs)}</span>}
            </>
          )}
        </div>
      </div>
    );
  };

  const tagFor = (task: LineTask): ReactNode => {
    if (task.holder && task.heldSince !== undefined && now - task.heldSince < PICKUP_MS) {
      const waited = task.since !== undefined ? task.heldSince - task.since : undefined;
      return (
        <>
          <span className="rounded-full bg-foreground px-1.5 text-[11px] leading-[18px] text-background">now</span>
          <span>{task.holder.name} picked up</span>
          {waited !== undefined && waited > 60_000 && <span className="text-muted-foreground">· waited {tokenTime(waited)}</span>}
          <span aria-hidden className="h-[1.5px] w-4 bg-state-claimed" />
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

  // A tag hangs into the gap left of its token: only where that gap is wide and empty.
  const mainStation = (stepId: string | undefined) => !!stepId && t.main.includes(stepId);
  const roomLeft = (stepId: string | undefined) => {
    const i = stepId ? t.main.indexOf(stepId) : -1;
    if (i <= 0) return false;
    const prev = t.main[i - 1];
    const gap = h.at.get(stepId!)!.x - h.at.get(prev)!.x;
    return gap >= 180 && !(columns.get(prev)?.length) && !props.hidden?.get(prev);
  };
  const token = (task: LineTask) => {
    const s = task.stepId ? stepOf(task.stepId) : undefined;
    const first = t.main[0] === task.stepId;
    return (
      <Token
        key={task.id}
        task={task}
        hold={!!s && isHoldStep(s)}
        now={now}
        selected={props.selected === task.id}
        ringed={!!props.ringed?.has(task.id)}
        dim={dimOthers && !inChain.has(task.id)}
        pulse={flow.pulses.get(task.id)}
        arrived={flow.arrived.has(task.id)}
        tag={first || roomLeft(task.stepId) || !mainStation(task.stepId) ? tagFor(task) : undefined}
        tagSide={first ? "right" : "left"}
        onClick={props.onSelect && (() => props.onSelect!(props.selected === task.id ? null : task.id))}
        onHover={props.onRing && ((on) => props.onRing!(on ? task.id : null))}
        compact={width < 900 && t.main.length > 6}
        noKey={!!trace}
      />
    );
  };

  const column = (id: string, x: number) => {
    if (props.fold) return null;
    const list = columns.get(id) ?? [];
    const hidden = props.hidden?.get(id) ?? 0;
    const past = traceStays.get(id);
    if (density === "beads") {
      if (list.length === 0) return null;
      return (
        <div key={`c-${id}`} className="absolute flex w-[54px] -translate-x-1/2 flex-wrap justify-center gap-1.5" style={{ left: x, top: h.columnY }}>
          {list.map((task) => (
            <Bead key={task.id} task={task} hold={!!stepOf(id) && isHoldStep(stepOf(id)!)} dim={dimOthers && !inChain.has(task.id)} />
          ))}
        </div>
      );
    }
    const shown = list.length > COLUMN_CAP ? list.slice(0, COLUMN_CAP - 1) : list;
    const more = list.length - shown.length;
    return (
      <div key={`c-${id}`} className="absolute flex -translate-x-1/2 flex-col items-center gap-1.5" style={{ left: x, top: h.columnY }}>
        {past && trace && (
          <div className="flex flex-col items-center gap-0.5">
            <Token task={{ ...(tasks[0] ?? { id: "past", key: "", title: "", kind: "work", blockers: [] }), holder: past.holder, blockers: [] }} hold={false} now={now} past={{ text: spanTime(past.worked) }} noKey />
            {past.waited > 60_000 && <span className="text-[11px] text-muted-foreground">waited {spanTime(past.waited)}</span>}
          </div>
        )}
        {shown.map((task) => (
          <Fragment key={task.id}>
            {token(task)}
            {trace?.current === id && trace.stays.at(-1)?.waited !== undefined && trace.stays.at(-1)!.waited > 60_000 && (
              <span className="text-[11px] text-muted-foreground">waited {spanTime(trace.stays.at(-1)!.waited)}</span>
            )}
          </Fragment>
        ))}
        {more > 0 && (
          <button type="button" onClick={() => setOpenStep(id)} className="rounded-full border px-2 text-[11px] leading-5 text-muted-foreground hover:text-foreground">
            +{more} more
          </button>
        )}
        {id === DONE_STATION &&
          doneTokens.map((d) => <Token key={d.id} task={{ id: d.id, key: d.key, title: d.title, kind: "work", blockers: [], done: true }} hold={false} now={now} onClick={props.onOpenTask && (() => props.onOpenTask!(d.key))} />)}
        {hidden > 0 && !props.compactHeads && <HiddenCount n={hidden} />}
      </div>
    );
  };

  const stroke = (tone: ReturnType<typeof routeTone>, base: string) =>
    tone === "trace" || tone === "next" || tone === "lit" ? "var(--state-claimed)" : tone === "dim" ? "var(--border)" : base;

  const arc = (a: DrawnArc, branch = false) => {
    const tone = routeTone(a.connectorIds);
    const base = a.back ? (a.side === "under" ? "var(--foreground)" : "var(--foreground)") : "var(--muted-foreground)";
    const dashed = tone === "next" || (!a.back && tone !== "trace");
    const sw = tone === "trace" ? 2.6 : a.back ? (a.id.startsWith("track:") ? 1.8 : 1.6) : 1.3;
    return (
      <g key={a.id} data-route={a.id} className={cn(tone === "dim" && "wl-dim")}>
        <path d={smooth(a.line)} fill="none" stroke={stroke(tone, base)} strokeWidth={sw} strokeDasharray={dashed ? "4 3" : undefined} />
        <path d={arrowhead(a.arrow.x, a.arrow.y, a.arrow.dir)} fill="none" stroke={stroke(tone, base)} strokeWidth={1.5} />
        {!branch && a.id.startsWith("track:")
          ? h.polylines
              .filter((p) => p.id.startsWith("drop:") && a.connectorIds.includes(p.id.slice(5)))
              .map((p) => {
                const dt = routeTone([p.id.slice(5)]);
                return <path key={p.id} d={smooth(p.points)} fill="none" stroke={stroke(dt === "plain" ? tone : dt, base)} strokeWidth={sw} />;
              })
          : null}
      </g>
    );
  };

  const label = (l: { x: number; y: number; text: string; back?: boolean; connectorId?: string; align?: "start" }, k: string, main = false) => {
    const tone = l.connectorId ? routeTone([l.connectorId], main) : props.litLoop ? "dim" : "plain";
    return (
      <span
        key={k}
        data-lit={l.connectorId && (lit.has(l.connectorId) || loopLit([l.connectorId])) ? "true" : undefined}
        className={cn(
          "pointer-events-none absolute -translate-y-1/2 rounded bg-background px-1.5 text-[11px] leading-4 whitespace-nowrap",
          l.align === "start" ? "font-semibold" : "-translate-x-1/2",
          l.back ? "text-foreground" : "text-muted-foreground",
          (tone === "trace" || tone === "next" || tone === "lit") && "font-semibold text-state-claimed",
          tone === "dim" && "opacity-40",
        )}
        style={{ left: l.x, top: l.y }}
      >
        {l.text}
      </span>
    );
  };

  // The chain drawn between tokens while a Task is selected: a rail beside a column, an arc between columns.
  const chainLines: { d: string; arrow: string; key: string; blue?: boolean }[] = [];
  const ghostAt = ((): { x: number; y: number; task: LineTask } | undefined => {
    if (!chain) return undefined;
    const q = chain.upstream.flat().find((x) => x.aimedAt && !x.stepId);
    if (!q) return undefined;
    const blocked = chain.task.blockers.some((b) => b.id === q.id) ? chain.task : chain.upstream.flat().find((x) => x.blockers.some((b) => b.id === q.id));
    const r = blocked && rects.get(blocked.key);
    if (!r) return undefined;
    // Into the nearest station to the left whose column is clear at that height.
    const y = r.y + r.h / 2;
    const xs = t.main.map((id) => h.at.get(id)!.x).filter((x) => x < r.x - 40);
    for (const x of xs.reverse()) {
      const clear = [...rects.values()].every((b) => Math.abs(b.y + b.h / 2 - y) > 20 || b.x > x + 75 || b.x + b.w < x - 75);
      if (clear) return { x, y, task: q };
    }
    return { x: Math.max(80, r.x - 110), y, task: q };
  })();
  if (chain) {
    const at = (key: string) => rects.get(key);
    const byId = new Map(all.map((x) => [x.id, x]));
    let rail = 0;
    for (const [from, to] of chain.links) {
      const a = byId.get(from);
      const b = byId.get(to);
      if (!a || !b) continue;
      const rb = at(b.key);
      if (!rb) continue;
      if (a.aimedAt && !a.stepId) {
        if (!ghostAt) continue;
        const x1 = ghostAt.x + 72;
        chainLines.push({ key: `${from}>${to}`, d: `M${x1} ${ghostAt.y} L${rb.x - 4} ${rb.y + rb.h / 2}`, arrow: arrowhead(rb.x - 4, rb.y + rb.h / 2, "right"), blue: true });
        continue;
      }
      const ra = at(a.key);
      if (!ra) continue;
      const sameColumn = Math.abs(ra.x + ra.w / 2 - (rb.x + rb.w / 2)) < 30;
      if (sameColumn) {
        const x = Math.max(ra.x + ra.w, rb.x + rb.w) + 10 + rail * 6;
        rail++;
        const ya = ra.y + ra.h / 2;
        const yb = rb.y + rb.h / 2;
        chainLines.push({ key: `${from}>${to}`, d: `M${ra.x + ra.w + 2} ${ya} H${x} V${yb} H${rb.x + rb.w + 4}`, arrow: arrowhead(rb.x + rb.w + 4, yb, "left") });
      } else {
        const leftToRight = ra.x < rb.x;
        const x1 = leftToRight ? ra.x + ra.w + 2 : ra.x - 2;
        const y1 = ra.y + ra.h / 2;
        const x2 = leftToRight ? rb.x - 4 : rb.x + rb.w + 4;
        const y2 = rb.y + rb.h / 2;
        const mx = (x1 + x2) / 2;
        chainLines.push({ key: `${from}>${to}`, d: `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`, arrow: arrowhead(x2, y2, leftToRight ? "right" : "left") });
      }
    }
  }

  const callout = ((): Box | undefined => {
    if (!chain || !selected) return undefined;
    const r = rects.get(selected.key);
    if (!r) return undefined;
    const avoid = [...rects.entries()].filter(([k]) => inChain.has(all.find((x) => x.key === k)?.id ?? "")).map(([, b]) => b);
    const all2 = [...rects.values()];
    const { w, h: ch } = calloutSize;
    const col = all2.filter((b) => Math.abs(b.x + b.w / 2 - (r.x + r.w / 2)) < 40);
    const colRight = Math.max(...col.map((b) => b.x + b.w), r.x + r.w);
    const colLeft = Math.min(...col.map((b) => b.x), r.x);
    // Clear of the tokens to its right where it can be, and of the line and its loops below.
    const rightTokens = all2.filter((b) => b.x > colRight);
    const underRight = rightTokens.length ? Math.max(...rightTokens.map((b) => b.y + b.h)) + 12 : r.y;
    const lineStrip: Box = { x: 0, y: h.lineY - 8, w: width, h: 16 + (t.maxUnder ? 20 + t.maxUnder * 22 : 0) };
    return placeCallout(
      [
        { x: colRight + 40, y: Math.min(underRight, h.lineY - ch - 6), w, h: ch },
        { x: colRight + 40, y: h.lineY - ch - 14, w, h: ch },
        { x: colLeft - w - 40, y: h.lineY - ch - 14, w, h: ch },
        { x: colRight + 40, y: r.y, w, h: ch },
        { x: r.x, y: h.lineY + 30, w, h: ch },
      ],
      [...all2, ...avoid, ...avoid, lineStrip],
      { w: width, h: h.height },
    );
  })();

  const travelling = flow.tokens
    .map((tk) => {
      if (tk.travel.to === DROPPED) return undefined;
      const to = tk.travel.to === DONE ? DONE_STATION : tk.travel.to;
      const route = (tk.travel.connectorId && h.routes.get(tk.travel.connectorId)) || handRoute(h, tk.travel.from, to);
      if (!route) return undefined;
      const outcome = tk.travel.connectorId ? facts.connectors.find((c) => c.id === tk.travel.connectorId)?.name : "by hand";
      return { id: tk.id, key: tk.key, route, outcome, hand: !tk.travel.connectorId };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);

  const ghostsAt = (id: string) => (props.ghosts ?? []).filter((g) => g.stepId === id);

  return (
    <div ref={box} className="relative w-full select-none" style={{ height: h.height }} onClick={(e) => e.target === e.currentTarget && props.onSelect?.(null)}>
      <svg aria-hidden className="pointer-events-none absolute top-0 left-0 overflow-visible" width={width} height={h.height}>
        {/* Guides from each head down to its station. */}
        {!props.fold &&
          t.main.map((id) => {
            const p = h.at.get(id)!;
            return <line key={`g-${id}`} x1={p.x} y1={h.guideTop} x2={p.x} y2={h.lineY - 9} stroke="var(--border)" />;
          })}
        {h.main.map((s) => {
          const tone = s.connectorId ? routeTone([s.connectorId], true) : props.fold ? "dim" : "plain";
          const hold = s.dotted;
          return (
            <line
              key={`m-${s.from}`}
              data-route={s.connectorId}
              x1={s.x1}
              y1={h.lineY}
              x2={s.x2}
              y2={h.lineY}
              stroke={hold ? "var(--muted-foreground)" : stroke(tone, "var(--foreground)")}
              strokeWidth={tone === "trace" ? 4 : hold ? 1.5 : tone === "next" ? 2.5 : 3}
              strokeDasharray={hold ? "2 5" : tone === "next" ? "6 4" : undefined}
              strokeLinecap="round"
              className={cn(tone === "dim" && !hold && "wl-dim")}
            />
          );
        })}
        {h.arcs.map((a) => arc(a))}
        {h.branch && (
          <g className={cn((dimOthers || props.litLoop) && "wl-dim")}>
            {h.branch.lines
              .filter((l) => l.id.startsWith("row:"))
              .map((l) => (
                <path key={l.id} d={smooth(l.points)} fill="none" stroke="var(--foreground)" strokeWidth={2} />
              ))}
            {h.branch.loops.map((a) => arc(a, true))}
            {h.branch.stations.map((s) => (
              <circle
                key={s.id}
                cx={s.x}
                cy={s.y}
                r={5.5}
                fill="var(--background)"
                stroke={ghostsAt(s.id).length ? "var(--state-claimed)" : "var(--foreground)"}
                strokeWidth={2}
                strokeDasharray={ghostsAt(s.id).length ? "3 2.5" : undefined}
              />
            ))}
          </g>
        )}
        {t.main.map((id) => {
          const p = h.at.get(id)!;
          const s = stepOf(id);
          const terminal = id === DONE_STATION;
          const glow = flow.glows.get(id);
          const visited = trace?.stays.some((x) => x.stepId === id);
          return (
            <circle
              key={`s-${id}`}
              data-station={id}
              cx={p.x}
              cy={p.y}
              r={terminal ? 8 : density === "beads" ? 6.5 : 7}
              fill={terminal ? "var(--state-done)" : "var(--background)"}
              stroke={terminal ? "var(--state-done)" : glow || visited ? "var(--state-claimed)" : "var(--foreground)"}
              strokeWidth={2.5}
              strokeDasharray={s && isHoldStep(s) ? "3 3" : undefined}
              className={cn(props.fold && !terminal && "opacity-60")}
            />
          );
        })}
        {chainLines.map((c) => (
          <g key={c.key}>
            <path className="wl-chain" d={c.d} fill="none" stroke={c.blue ? "var(--state-waiting)" : "var(--foreground)"} strokeWidth={1.6} />
            <path d={c.arrow} fill="none" stroke={c.blue ? "var(--state-waiting)" : "var(--foreground)"} strokeWidth={1.6} />
          </g>
        ))}
      </svg>

      {h.segmentLabels.map((l, i) => label(l, `sl-${i}`, true))}
      {h.arcs.flatMap((a) => a.labels.map((l, i) => label(l, `al-${a.id}-${i}`)))}
      {t.main.map((id) => head(id, h.at.get(id)!.x))}
      {t.main.map((id) => column(id, h.at.get(id)!.x))}

      {h.chips.map((c, i) => (
        <span
          key={`chip-${i}`}
          className={cn(
            "absolute rounded-full border border-dashed bg-background px-2 text-[11px] leading-[18px] whitespace-nowrap text-muted-foreground",
            c.align === "right" && "-translate-x-full",
            c.align === "center" && "-translate-x-1/2",
            (dimOthers || props.litLoop) && "wl-dim",
          )}
          style={{ left: c.x, top: c.y }}
        >
          {c.text}
        </span>
      ))}

      {h.branch && (
        <div className={cn((dimOthers || props.litLoop) && "wl-dim")}>
          <div className={cn("absolute text-[11px] text-muted-foreground", props.branchLabel !== "After a Parent" && "font-medium text-state-claimed")} style={{ left: h.branch.label.x, top: h.branch.label.y }}>
            {props.branchLabel}
          </div>
          {h.branch.labels.map((l, i) => label(l, `bl-${i}`))}
          {h.branch.loops.flatMap((a) => a.labels.map((l, i) => label(l, `bll-${a.id}-${i}`)))}
          {h.branch.stations.map((bs) => {
            const s = stepOf(bs.id);
            if (!s) return null;
            const here = columns.get(bs.id) ?? [];
            const takers = s.takers ?? [];
            const paused = takers.length > 0 && takers.every((m) => m.paused);
            const hidden = props.hidden?.get(bs.id) ?? 0;
            return (
              <div key={bs.id} className="absolute flex items-center gap-1.5 whitespace-nowrap" style={{ left: bs.x - 6, top: bs.y - 36 }}>
                <span className="text-[13px] font-semibold">{s.name}</span>
                {!props.compactHeads && !props.ghosts?.length && s.skill && <span className="font-mono text-[11px] text-muted-foreground">{s.skill.name}</span>}
                {!props.compactHeads && (!props.ghosts?.length || paused) && takers.slice(0, 2).map((m) => <MemberAvatar key={m.id} member={m} working={m.working} />)}
                {paused && <span className="rounded-full border px-1.5 text-[10.5px] leading-4 text-muted-foreground">paused</span>}
                {here.slice(0, 2).map((task) => token(task))}
                {here.length > 2 && <span className="text-[11px] text-muted-foreground">+{here.length - 2}</span>}
                {ghostsAt(bs.id).map((g) => (
                  <GhostToken key={g.label} text={g.text} label={g.label} />
                ))}
                {hidden > 0 && <HiddenCount n={hidden} />}
              </div>
            );
          })}
        </div>
      )}

      {ghostAt && (
        <span
          className="absolute inline-flex h-[30px] -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-full border-[1.5px] border-dashed border-state-waiting bg-background pr-2.5 pl-1.5 text-xs whitespace-nowrap"
          style={{ left: ghostAt.x, top: ghostAt.y }}
          aria-label={`${ghostAt.task.key} ${ghostAt.task.title}, with ${ghostAt.task.aimedAt?.id === props.me.id ? "you" : ghostAt.task.aimedAt?.name}`}
        >
          {ghostAt.task.aimedAt && <MemberAvatar member={ghostAt.task.aimedAt} />}
          <span className="font-mono text-[11.5px]">{ghostAt.task.key}</span>
          <span className="text-muted-foreground">with {ghostAt.task.aimedAt?.id === props.me.id ? "you" : ghostAt.task.aimedAt?.name}</span>
        </span>
      )}

      {travelling.map((tk) => (
        <div
          key={tk.id}
          className="wl-travel pointer-events-none absolute top-0 left-0 z-10"
          style={{ offsetPath: `path("${tk.route}")` }}
          data-travel={tk.key}
        >
          <span className={cn("wl-token inline-flex h-[26px] items-center gap-1.5 rounded-full border-[1.5px] bg-background px-2.5 text-xs whitespace-nowrap shadow-pop", tk.hand && "border-dashed")} data-state="waiting">
            <span className="font-mono text-[11.5px]">{tk.key}</span>
            {tk.outcome && <span className="text-muted-foreground">{tk.outcome}</span>}
          </span>
        </div>
      ))}

      {openStep && <StepTokens h={h} id={openStep} name={stepOf(openStep)?.name ?? ""} tasks={columns.get(openStep) ?? []} onClose={() => setOpenStep(null)} render={token} />}

      {chain && (
        <div
          ref={calloutRef}
          role="dialog"
          aria-label={`${chain.task.key} Blocking`}
          className="absolute z-20 w-max max-w-[min(560px,calc(100%-16px))] rounded-lg border bg-popover px-3 py-2.5 text-popover-foreground shadow-pop"
          style={callout ? { left: callout.x, top: callout.y } : { left: 8, top: 8, visibility: "hidden" }}
        >
          <ChainCallout chain={chain} me={props.me.id} takeable={props.me.takeable} action={props.actionFor?.(chain.first)} onOpen={props.onOpenTask} now={now} />
        </div>
      )}
    </div>
  );
}

/** A crowded Step opened: its Tasks as full tokens, hung under the line where it covers nothing drawn. */
function StepTokens({ h, id, name, tasks, onClose, render }: { h: Laid; id: string; name: string; tasks: LineTask[]; onClose: () => void; render: (t: LineTask) => ReactNode }) {
  const p = h.at.get(id);
  if (!p) return null;
  const blocked = tasks.filter((t) => t.blockers.length > 0 && !t.holder).length;
  const left = Math.max(8, Math.min(p.x - 60, h.width - 340));
  return (
    <div role="dialog" aria-label={`Tasks at ${name}`} onMouseLeave={onClose} className="absolute z-20 w-[330px] rounded-lg border bg-popover p-3 shadow-pop" style={{ left, top: h.lineY + 48 }}>
      <div className="mb-2 flex items-baseline justify-between text-[13px] font-semibold">
        {name}
        <span className="text-xs font-normal text-muted-foreground">
          {tasks.length} {tasks.length === 1 ? "Task" : "Tasks"}
          {blocked > 0 && ` · ${blocked} blocked`}
        </span>
      </div>
      <div className="grid grid-cols-2 justify-items-start gap-1.5">{tasks.map((t) => render(t))}</div>
      <button type="button" className="sr-only" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

