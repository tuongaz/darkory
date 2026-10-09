import { ArrowUpRightIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Pill } from "@/components/Pill";
import { Button } from "@/components/ui/button";
import { WorkGlyph } from "@/components/WorkGlyph";
import { cn } from "@/lib/utils";
import { glyphFor, type SubtaskCounts } from "@/lib/work";
import type { GraphStep } from "../graph";
import type { Point } from "../model";
import { roundedPath } from "../route";
import { ageText } from "@/lib/time";
import { acrossGeometry, analyseBlocking, downGeometry, endsText, ownWorkflowSteps, placeBlocking, type BlockingAnalysis, type BlockingLayout, type BlockingTask, type PlacedNode } from "./layout";

/** A Parent as a band's header names it. */
export type BandParent = { id: string; key: string; title: string; counts?: SubtaskCounts };

export type BlockingBoardProps = {
  /** Every open Task known: the Organisation's, since a Blocking may cross Parents and Projects. */
  tasks: readonly BlockingTask[];
  projectId: string;
  /** A Task's id: a Parent's Subtasks, or one Task's chain. */
  scope?: string;
  /** The Steps of the Workflow shown, on the page of one of several: the Project's Tasks elsewhere join only as outside Tasks. */
  workflowSteps?: ReadonlySet<string>;
  /** The signed-in Member's id. */
  me: string;
  now: number;
  /** Each Project's Steps in Workflow order, for a node's Step and its place on the line. */
  steps: ReadonlyMap<string, readonly GraphStep[]>;
  parents: ReadonlyMap<string, BandParent>;
  /** Projects by id, for a band of another Project's Tasks. */
  projects: ReadonlyMap<string, { key: string; name: string }>;
  /** Opens a Task's peek, by id. */
  onOpen: (id: string) => void;
  onShowOnLine: (id: string) => void;
  /** Where a Parent's band header links: its Subtask graph. */
  graphLink?: (parentKey: string) => string;
};

/** Below this width the view runs down: depth top to bottom, the bands stacked. */
const PHONE = 640;
/** The side cards' column, beside the graph on a wide screen; narrower when four columns or more want the room. */
const SIDE_W = 280;
const SIDE_NARROW = 220;
const SIDE_GAP = 20;

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  return [ref, width];
}

/** What a node says of itself in its last row's tag. */
function tagOf(t: BlockingTask, blockers: number, me: string): { text: string; tone: "working" | "waiting" | "blocked" | "plain" } | undefined {
  if (t.holder) return { text: t.holder.working === "waiting" ? "Shift waiting" : t.holder.working === "stalled" ? "Shift stalled" : "Working", tone: "working" };
  if (blockers > 1) return { text: `by ${blockers}`, tone: "blocked" };
  if (blockers === 1) return { text: "Blocked", tone: "blocked" };
  if (t.aimedAt) return { text: t.aimedAt.id === me ? "With you" : `With ${t.aimedAt.name}`, tone: "waiting" };
  if (t.takeable) return { text: "Takeable", tone: "waiting" };
  return undefined;
}

type Tone = "working" | "idle" | "blocked" | "waiting" | "plain";

function toneOf(t: BlockingTask, blockers: number): Tone {
  if (t.holder) return t.holder.working === "running" || t.holder.working === "held" ? "working" : "idle";
  if (blockers > 0) return "blocked";
  if (t.takeable || t.aimedAt) return "waiting";
  return "plain";
}

/**
 * The Task's place on its Workflow: a dot per Step and one for Done, its own filled in its
 * state's colour, Done green. Nothing for a Task at no Step.
 */
function MicroLine({ steps, at, tone, small }: { steps: readonly GraphStep[]; at?: string; tone: Tone; small: boolean }) {
  const i = at ? steps.findIndex((s) => s.id === at) : -1;
  if (i < 0) return null;
  const many = small || steps.length > 8;
  return (
    <span aria-hidden className={cn("relative inline-flex flex-none items-center", many ? "gap-[1.5px]" : "gap-[3px]")}>
      <span className="absolute inset-x-0.5 top-1/2 h-px bg-ring" />
      {[...steps, null].map((s, j) => (
        <i
          key={s?.id ?? "done"}
          className={cn(
            "relative rounded-full border border-ring bg-background",
            many ? "size-1" : "size-[5px]",
            j === steps.length && "border-state-done bg-state-done",
            j === i && cn("-mx-px border-0", many ? "size-1.5" : "size-[7px]", dot[tone]),
          )}
        />
      ))}
    </span>
  );
}

const dot: Record<Tone, string> = {
  working: "bg-state-claimed",
  idle: "bg-state-claimed",
  blocked: "bg-state-blocked",
  waiting: "bg-state-waiting",
  plain: "bg-foreground",
};

const border: Record<Tone, string> = {
  working: "border-state-claimed bg-state-claimed-bg",
  idle: "border-dashed border-state-claimed bg-state-claimed-bg",
  blocked: "border-state-blocked",
  waiting: "border-state-waiting",
  plain: "",
};

function nodeLabel(t: BlockingTask, step: string | undefined, blockers: string[], tag: string | undefined): string {
  const parts = [`${t.key} ${t.title}`, step ? `at ${step}` : "at no Step"];
  if (t.holder) parts.push(`held by ${t.holder.name}`);
  if (blockers.length) parts.push(`blocked by ${blockers.join(", ")}`);
  else if (tag && !t.holder) parts.push(tag);
  return parts.join(", ");
}

function Node({
  node,
  task,
  steps,
  blockers,
  me,
  now,
  longest,
  selected,
  dimmed,
  onSelect,
}: {
  node: PlacedNode;
  task: BlockingTask;
  steps: readonly GraphStep[];
  blockers: string[];
  me: string;
  now: number;
  longest: boolean;
  selected: boolean;
  dimmed: boolean;
  onSelect: () => void;
}) {
  const tone = toneOf(task, blockers.length);
  // A narrow node leaves Working to the holder's turning mark.
  const narrow = node.w < 210;
  const tag = narrow && task.holder ? undefined : tagOf(task, blockers.length, me);
  const step = task.stepId ? steps.find((s) => s.id === task.stepId) : undefined;
  const glyph = glyphFor({ state: "open", held: !!task.holder, holderKind: task.holder?.kind, session: task.holder?.working === "held" ? undefined : task.holder?.working, blocked: blockers.length > 0, atHold: !!step && !step.skill });
  return (
    <button
      type="button"
      aria-label={nodeLabel(task, step?.name, blockers, tag?.text)}
      aria-pressed={selected}
      data-task={task.key}
      data-longest={longest || undefined}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      className={cn(
        "absolute flex cursor-pointer flex-col gap-[3px] rounded-lg border-[1.5px] bg-card px-[9px] py-1.5 text-left text-card-foreground shadow-soft transition-opacity duration-150 hover:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none motion-reduce:transition-none",
        border[tone],
        longest && !selected && "ring-1 ring-foreground",
        selected && "ring-2 ring-foreground ring-offset-2 ring-offset-background",
        dimmed && "opacity-30",
      )}
      // Placed by the layout: a CSSOM write, which the CSP allows.
      style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
    >
      <span className="flex h-4 min-w-0 items-center gap-1.5 whitespace-nowrap">
        <span aria-hidden className="flex">
          <WorkGlyph glyph={glyph} className="size-3" />
        </span>
        <span className="font-mono text-xs text-muted-foreground">{task.key}</span>
        <span className="ml-auto truncate text-2xs text-muted-foreground">{step?.name ?? "at no Step"}</span>
      </span>
      <span className="truncate text-[12.5px] leading-[17px] font-medium">{task.title}</span>
      <span className={cn("flex h-5 min-w-0 items-center overflow-hidden text-[11.5px] whitespace-nowrap text-muted-foreground", narrow ? "gap-1" : "gap-1.5")}>
        <MicroLine steps={steps} at={task.stepId} tone={tone} small={node.w < 210} />
        {task.holder ? (
          <MemberAvatar member={task.holder} working={task.holder.working} className="size-[18px] text-[8px]" />
        ) : (
          task.aimedAt && <MemberAvatar member={task.aimedAt} className="size-[18px] text-[8px]" />
        )}
        <span className="flex-none tabular-nums">{ageText(now - task.since)}</span>
        {tag &&
          (tag.tone === "blocked" ? (
            <span className="ml-auto flex-none font-medium text-state-blocked">{tag.text}</span>
          ) : (
            <Pill tone={tag.tone === "working" ? "claimed" : "waiting"} className="ml-auto h-[18px] flex-none px-1.5 text-2xs">
              {tag.text}
            </Pill>
          ))}
      </span>
    </button>
  );
}

/** The arrowhead at a polyline's end, pointing the way its last leg runs. */
function head(points: Point[]): string {
  const [p, q] = [points[points.length - 2], points[points.length - 1]];
  const dx = Math.sign(q.x - p.x);
  const dy = Math.sign(q.y - p.y);
  const [l, w] = [7, 4.5];
  return `M ${q.x - dx * l - dy * w} ${q.y - dy * l - dx * w} L ${q.x} ${q.y} L ${q.x - dx * l + dy * w} ${q.y - dy * l + dx * w}`;
}

function Arrows({ layout, lit, heavy }: { layout: BlockingLayout; lit?: Set<string>; heavy: boolean }) {
  return (
    <svg aria-hidden className="pointer-events-none absolute top-0 left-0 overflow-visible" width={layout.width} height={layout.height}>
      {layout.edges.map((e) => {
        const on = lit ? lit.has(e.id) : heavy && e.longest;
        const dim = !!lit && !on;
        const cls = cn("fill-none transition-opacity duration-150 motion-reduce:transition-none", on ? "stroke-foreground" : "stroke-muted-foreground", dim && "opacity-25");
        const width = on ? 2.4 : 1.5;
        return (
          <g key={e.id} data-edge={e.id} data-longest={e.longest || undefined}>
            <path d={roundedPath(e.points, 7)} className={cls} strokeWidth={width} />
            <path d={head(e.points)} className={cls} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />
          </g>
        );
      })}
    </svg>
  );
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function Keys({ ids, keyOf }: { ids: string[]; keyOf: (id: string) => string }) {
  return <span className="font-mono">{ids.map(keyOf).join(", ")}</span>;
}

/**
 * The Blocking of a Project, or of a Parent's Subtasks, as a graph: the Tasks that block or are
 * blocked as nodes, each Blocking an arrow, laid out by what must end first (columns "Ends 1st",
 * "Ends 2nd"…), a band per Parent and one for Tasks with no Parent, the longest chain drawn heavy.
 * Beside it: what the signed-in Member can do first, the longest chain as a sentence, and the
 * Tasks with no Blocking. A node selects its chain and opens a card that says what it waits on,
 * with Show on line and Open. On a phone it runs down, the side cards above and below.
 */
export function BlockingBoard({ tasks, projectId, scope, workflowSteps, me, now, steps, parents, projects, onOpen, onShowOnLine, graphLink }: BlockingBoardProps) {
  const [rootRef, rootWidth] = useWidth<HTMLDivElement>();
  const width = rootWidth || 1200;
  const phone = width < PHONE;
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const a = useMemo(() => analyseBlocking(tasks, { projectId, scope, me, steps: workflowSteps }), [tasks, projectId, scope, me, workflowSteps]);
  const side = a.depths >= 4 ? SIDE_NARROW : SIDE_W;
  const fit = phone ? width : width - side - SIDE_GAP;
  const layout = useMemo(() => placeBlocking(byId, a, phone ? downGeometry : acrossGeometry, { projectId, scope, fit }), [byId, a, phone, projectId, scope, fit]);
  const [selected, setSelected] = useState<string | null>(null);
  const keyOf = (id: string) => byId.get(id)?.key ?? id;
  const stepsOf = (id: string) => ownWorkflowSteps(steps.get(byId.get(id)!.projectId) ?? [], byId.get(id)!.stepId);

  // A selection that no longer stands (it ended, the scope changed) clears.
  const current = selected && a.nodes.includes(selected) ? selected : null;
  useEffect(() => {
    if (!current) return;
    const off = (e: KeyboardEvent) => e.key === "Escape" && setSelected(null);
    window.addEventListener("keydown", off);
    return () => window.removeEventListener("keydown", off);
  }, [current]);

  const from = (id: string) => a.edges.filter(([b]) => b === id).map(([, z]) => z);
  const chain = useMemo(() => {
    if (!current) return undefined;
    const nodes = new Set([current]);
    const edges = new Set<string>();
    const walk = (id: string, next: (id: string) => string[], edge: (x: string, y: string) => string) => {
      for (const n of next(id)) {
        edges.add(edge(id, n));
        if (!nodes.has(n)) {
          nodes.add(n);
          walk(n, next, edge);
        }
      }
    };
    walk(current, (id) => a.edges.filter(([, z]) => z === id).map(([b]) => b), (x, y) => `${y}->${x}`);
    walk(current, (id) => a.edges.filter(([b]) => b === id).map(([, z]) => z), (x, y) => `${x}->${y}`);
    return { nodes, edges };
  }, [current, a.edges]);

  const empty = a.nodes.length === 0;
  const first = <FirstCard a={a} byId={byId} keyOf={keyOf} onOpen={onOpen} compact={phone} />;
  const longest = <LongestCard a={a} keyOf={keyOf} onSelect={setSelected} />;
  const none = <NoBlockingCard a={a} byId={byId} steps={steps} now={now} onOpen={onOpen} compact={phone || a.noBlocking.length > 6} />;

  return (
    <div ref={rootRef} className="flex min-w-0 flex-col gap-3" data-orientation={layout.orientation}>
      <div className="flex min-h-7 flex-wrap items-center gap-x-3.5 gap-y-1 text-[12.5px] whitespace-nowrap">
        <span>
          <b className="font-semibold tabular-nums">{a.edges.length}</b> {a.edges.length === 1 ? "Blocking" : "Blockings"}
        </span>
        <span>
          <b className="font-semibold tabular-nums">{a.blocked}</b> Blocked
        </span>
        <span>
          <b className="font-semibold tabular-nums">{a.nodes.length - a.outside.size}</b> of {plural(a.shown, "open Task")}
        </span>
        {!phone && <Legend />}
      </div>
      {phone && first}
      <div className={cn("flex min-w-0 gap-5", phone && "flex-col gap-3")}>
        {empty ? (
          <p className="flex-1 rounded-lg border border-dashed p-6 text-center text-muted-foreground">No open Task here blocks another.</p>
        ) : (
          <div role="region" aria-label="Blocking, graph" className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain" onClick={() => setSelected(null)}>
            <div className="relative" style={{ width: layout.width, height: layout.height + (current ? 150 : 0) }}>
              {layout.columns.map((c) => (
                <div key={c.depth} aria-hidden className="absolute top-1 text-[11px] whitespace-nowrap text-muted-foreground" style={{ left: c.x }}>
                  {endsText(c.depth)}
                </div>
              ))}
              {layout.bands.map((b) => (
                <div key={b.id} aria-hidden className="absolute rounded-[10px] border bg-sidebar" style={{ left: b.x, top: b.y, width: b.w, height: b.h }} />
              ))}
              <Arrows layout={layout} lit={chain?.edges} heavy={!chain} />
              {layout.bands.map((b) => (
                <BandHeader key={b.id} band={b} parent={b.parentId ? parents.get(b.parentId) : undefined} project={b.projectId === projectId ? undefined : projects.get(b.projectId)} scoped={!!scope} graphLink={graphLink} />
              ))}
              {layout.nodes.map((n) => (
                <Node
                  key={n.id}
                  node={n}
                  task={byId.get(n.id)!}
                  steps={stepsOf(n.id)}
                  blockers={byId.get(n.id)!.blockedBy.filter((b) => byId.has(b)).map(keyOf)}
                  me={me}
                  now={now}
                  longest={!chain && a.longest.includes(n.id)}
                  selected={current === n.id}
                  dimmed={!!chain && !chain.nodes.has(n.id)}
                  onSelect={() => setSelected(current === n.id ? null : n.id)}
                />
              ))}
              {current && (
                <ChainCard
                  node={layout.nodes.find((n) => n.id === current)!}
                  layout={layout}
                  task={byId.get(current)!}
                  blockers={byId.get(current)!.blockedBy.filter((b) => byId.has(b))}
                  blocks={from(current)}
                  a={a}
                  byId={byId}
                  me={me}
                  keyOf={keyOf}
                  onOpen={onOpen}
                  onShowOnLine={onShowOnLine}
                />
              )}
            </div>
          </div>
        )}
        {!phone && (
          <aside aria-label="Blocking, in words" className="flex flex-none flex-col gap-3" style={{ width: side }}>
            {first}
            {longest}
            {none}
          </aside>
        )}
      </div>
      {phone && (
        <>
          {longest}
          {none}
        </>
      )}
    </div>
  );
}

function Legend() {
  const item = (mark: ReactNode, label: string) => (
    <span className="inline-flex items-center gap-1.5">
      {mark}
      {label}
    </span>
  );
  return (
    <span aria-hidden className="ml-auto flex items-center gap-3 text-[11.5px] text-muted-foreground">
      {item(<span className="h-2.5 w-3.5 rounded-[3px] border-[1.5px] border-state-claimed bg-state-claimed-bg" />, "Working")}
      {item(<span className="h-2.5 w-3.5 rounded-[3px] border-[1.5px] border-state-waiting" />, "Takeable · With you")}
      {item(<span className="h-2.5 w-3.5 rounded-[3px] border-[1.5px] border-state-blocked" />, "Blocked")}
      {item(<span className="h-[2.4px] w-[22px] bg-foreground" />, "Longest chain")}
    </span>
  );
}

function BandHeader({
  band,
  parent,
  project,
  scoped,
  graphLink,
}: {
  band: BlockingLayout["bands"][number];
  parent?: BandParent;
  project?: { key: string; name: string };
  scoped: boolean;
  graphLink?: (parentKey: string) => string;
}) {
  const where = band.outside ? (project ? `In ${project.name}` : "Outside") : project ? project.name : undefined;
  return (
    <div className="absolute flex max-w-full items-center gap-2 rounded bg-sidebar pr-1 text-xs whitespace-nowrap" style={{ left: band.x + 12, top: band.y + 7, maxWidth: band.w - 24 }}>
      {where && <span className="text-muted-foreground">{where} ·</span>}
      {band.parentId ? (
        <>
          <span className="font-mono text-muted-foreground">{parent?.key}</span>
          <b className="truncate font-semibold">{parent?.title}</b>
          {parent?.counts && (
            <span className="text-muted-foreground">
              Subtasks {parent.counts.done}/{parent.counts.open + parent.counts.done + parent.counts.dropped} done
            </span>
          )}
          {parent && graphLink && !(scoped && !band.outside) && (
            <Link to={graphLink(parent.key)} className="inline-flex items-center underline underline-offset-2 hover:text-foreground">
              Graph
              <ArrowUpRightIcon aria-hidden className="size-3" />
            </Link>
          )}
        </>
      ) : (
        <b className="font-semibold">No Parent</b>
      )}
    </div>
  );
}

function Card({ title, count, children, className }: { title: string; count?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cn("rounded-lg border bg-card px-3 py-2.5", className)}>
      <h3 className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-semibold">
        {title}
        {count !== undefined && <span className="font-medium text-muted-foreground">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

function unblocksText(ids: string[], keyOf: (id: string) => string) {
  return ids.length ? `unblocks ${ids.map(keyOf).join(", ")}` : undefined;
}

function FirstCard({ a, byId, keyOf, onOpen, compact }: { a: BlockingAnalysis; byId: Map<string, BlockingTask>; keyOf: (id: string) => string; onOpen: (id: string) => void; compact: boolean }) {
  if (a.first) {
    const f = a.first;
    const then = unblocksText(f.unblocks, keyOf) ?? `leads to ${plural(f.leadsTo, "Task")}`;
    const row = (
      <div className="flex min-h-7 items-center gap-1.5 text-xs">
        {compact && <span className="text-muted-foreground">First</span>}
        <span className="min-w-0" title={byId.get(f.id)?.title}>
          {f.verb} <span className="font-mono">{keyOf(f.id)}</span> <span className="text-muted-foreground">· {then}</span>
        </span>
        <Button variant="outline" size="sm" className={cn("ml-auto", compact && "h-11 sm:h-8")} onClick={() => onOpen(f.id)}>
          {f.verb}
        </Button>
      </div>
    );
    return compact ? (
      <section aria-label="First for you" className="rounded-lg border bg-card px-3 py-1">
        {row}
      </section>
    ) : (
      <Card title="First for you">{row}</Card>
    );
  }
  if (a.takeableNow.length === 0) return null;
  return (
    <Card title="Takeable now" count={a.takeableNow.length}>
      <ul className="flex flex-col text-xs leading-5">
        {a.takeableNow.slice(0, 4).map((x) => (
          <li key={x.id}>
            <button type="button" className="text-left hover:underline" onClick={() => onOpen(x.id)}>
              <span className="font-mono">{keyOf(x.id)}</span>
              {x.unblocks.length > 0 && <span className="text-muted-foreground"> · {unblocksText(x.unblocks, keyOf)}</span>}
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function LongestCard({ a, keyOf, onSelect }: { a: BlockingAnalysis; keyOf: (id: string) => string; onSelect: (id: string) => void }) {
  if (a.longest.length === 0) return null;
  return (
    <Card title="Longest chain" count={plural(a.longest.length, "Task")}>
      <p className="text-xs leading-5">
        {a.longest.map((id, i) => (
          <span key={id}>
            <span className="whitespace-nowrap">
              <button type="button" className="font-mono hover:underline" onClick={() => onSelect(id)}>
                {keyOf(id)}
              </button>
              {i < a.longest.length - 1 && <span className="text-muted-foreground"> →</span>}
            </span>{" "}
          </span>
        ))}
      </p>
    </Card>
  );
}

function NoBlockingCard({
  a,
  byId,
  steps,
  now,
  onOpen,
  compact,
}: {
  a: BlockingAnalysis;
  byId: Map<string, BlockingTask>;
  steps: ReadonlyMap<string, readonly GraphStep[]>;
  now: number;
  onOpen: (id: string) => void;
  compact: boolean;
}) {
  if (a.noBlocking.length === 0) return null;
  const glyph = (t: BlockingTask) => {
    const step = steps.get(t.projectId)?.find((s) => s.id === t.stepId);
    return glyphFor({ state: "open", held: !!t.holder, holderKind: t.holder?.kind, session: t.holder?.working === "held" ? undefined : t.holder?.working, atHold: !!step && !step.skill });
  };
  if (compact)
    return (
      <Card title="No Blocking" count={a.noBlocking.length}>
        <ul className="flex flex-wrap gap-1.5">
          {a.noBlocking.map((id) => {
            const t = byId.get(id)!;
            return (
              <li key={id}>
                <button type="button" title={t.title} onClick={() => onOpen(id)} className="inline-flex h-[22px] items-center gap-1 rounded-full border px-[7px] font-mono text-[11px] whitespace-nowrap hover:bg-accent">
                  <WorkGlyph glyph={glyph(t)} className="size-2.5" />
                  {t.key}
                </button>
              </li>
            );
          })}
        </ul>
      </Card>
    );
  return (
    <Card title="No Blocking" count={a.noBlocking.length}>
      <ul className="flex flex-col">
        {a.noBlocking.map((id) => {
          const t = byId.get(id)!;
          const step = steps.get(t.projectId)?.find((s) => s.id === t.stepId);
          return (
            <li key={id}>
              <button
                type="button"
                title={t.title}
                onClick={() => onOpen(id)}
                className="grid h-6 w-full grid-cols-[14px_58px_minmax(0,1fr)_auto] items-center gap-1.5 text-left text-xs whitespace-nowrap hover:bg-accent"
              >
                <WorkGlyph glyph={glyph(t)} className="size-3" />
                <span className="font-mono text-muted-foreground">{t.key}</span>
                <span className="truncate">{step ? (step.skill ? `${step.name} · ${t.holder?.name ?? step.skill.name}` : step.name) : t.aimedAt ? `With ${t.aimedAt.name}` : "at no Step"}</span>
                <span className="text-muted-foreground tabular-nums">{ageText(now - t.since)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** "both", "all 3": how many blockers a Task waits on, when more than one. */
function allOf(n: number) {
  return n === 2 ? "both" : `all ${n}`;
}

function ChainCard({
  node,
  layout,
  task,
  blockers,
  blocks,
  a,
  byId,
  me,
  keyOf,
  onOpen,
  onShowOnLine,
}: {
  node: PlacedNode;
  layout: BlockingLayout;
  task: BlockingTask;
  blockers: string[];
  blocks: string[];
  a: BlockingAnalysis;
  byId: Map<string, BlockingTask>;
  me: string;
  keyOf: (id: string) => string;
  onOpen: (id: string) => void;
  onShowOnLine: (id: string) => void;
}) {
  // The first that must end: the chain's start upstream, what the signed-in Member can act on first.
  const roots: string[] = [];
  const seen = new Set<string>();
  const up = (id: string) => {
    for (const [b, z] of a.edges)
      if (z === id && !seen.has(b)) {
        seen.add(b);
        if (!a.edges.some(([, y]) => y === b)) roots.push(b);
        up(b);
      }
  };
  up(task.id);
  const act = (id: string) => {
    const t = byId.get(id)!;
    if (t.holder?.id === me) return "continue";
    if (t.aimedAt?.id === me && !t.holder) return "answer";
    if (t.takeableByMe) return "take";
    return undefined;
  };
  const mine = roots.find((r) => act(r));
  const firstLine = mine ? (
    <>
      {act(mine)} <span className="font-mono">{keyOf(mine)}</span>
    </>
  ) : roots.length ? (
    <>
      <span className="font-mono">{roots.map(keyOf).join(", ")}</span> {roots.length === 1 ? "ends" : "end"}
      {roots.length === 1 && byId.get(roots[0])!.holder && <span className="text-muted-foreground"> · {byId.get(roots[0])!.holder!.name} on it</span>}
    </>
  ) : undefined;
  const unblocks = blocks.filter((z) => byId.get(z)!.blockedBy.every((b) => b === task.id || !byId.has(b)));
  const W = Math.min(280, layout.width - 8);
  const left = Math.max(4, Math.min(node.x + node.w / 2 - W / 2, layout.width - W - 4));
  return (
    <div
      role="dialog"
      aria-label={`${task.key}, its chain`}
      onClick={(e) => e.stopPropagation()}
      className="absolute z-10 flex flex-col gap-1.5 rounded-lg border bg-popover p-3 text-xs text-popover-foreground shadow-md"
      style={{ left, top: node.y + node.h + 10, width: W }}
    >
      {blockers.length > 0 && (
        <p className="flex items-center gap-1.5">
          <Pill tone="blocked">Blocked</Pill>
          <span>
            by <Keys ids={blockers} keyOf={keyOf} />
            {blockers.length > 1 && <span className="text-muted-foreground"> · {allOf(blockers.length)}</span>}
          </span>
        </p>
      )}
      {firstLine && (
        <p>
          <span className="font-medium">First:</span> {firstLine}
        </p>
      )}
      {blocks.length > 0 && (
        <p>
          {unblocks.length ? "Unblocks" : "Blocks"} <Keys ids={unblocks.length ? unblocks : blocks} keyOf={keyOf} />
          {unblocks.length > 0 && <span className="text-muted-foreground"> when it ends</span>}
        </p>
      )}
      <div className="mt-1 flex items-center border-t pt-2">
        <Button variant="outline" size="sm" onClick={() => onShowOnLine(task.id)}>
          Show on line
        </Button>
        <button type="button" className="ml-auto underline underline-offset-2 hover:text-foreground" onClick={() => onOpen(task.id)}>
          Open {task.key}
        </button>
      </div>
    </div>
  );
}
