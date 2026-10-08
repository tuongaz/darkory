import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { quiet, type FlowState } from "@/components/workflow/live";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { ChainCallout } from "./Callout";
import { chainOf, type Chain, type Ghost, type Trace } from "./data";
import { HorizontalLine } from "./Horizontal";
import { densityFor, lineTopology, type Density, type Loop } from "./layout";
import type { LineFacts, LineTask } from "./model";
import { VerticalLine } from "./Vertical";

/** Under this width the line runs down the page. */
export const VERTICAL_BELOW = 640;
/** Loops back from which the line lists them by name. */
export const LOOPS_LISTED = 5;

export type WorkflowLineProps = {
  /** The Workflow with its Steps' takers and medians. */
  workflow: LineFacts;
  /** The Tasks drawn as tokens at their Steps (the scope's). */
  tasks: readonly LineTask[];
  /** Every open Task of the Project: where a selected Task's chain is walked. Defaults to `tasks`. */
  all?: readonly LineTask[];
  /** Per Step, the open Tasks there outside the scope: a faint "+N". */
  hidden?: ReadonlyMap<string, number>;
  /** Subtasks that ended Done, drawn green at Done (a Parent's scope). */
  done?: readonly { id: string; key: string; title: string }[];
  ghosts?: readonly Ghost[];
  branchLabel?: string;
  /** A Parent with nothing on the main line: the main line folds to a strip of names. */
  fold?: boolean;
  /** Tasks that reached Done today: "1 today" under Done. */
  doneToday?: number;
  /** One Task's path: traced on the line, its next outcomes dashed. */
  trace?: Trace;
  /** What plays on the line as it happens (useLiveFlow). */
  flow?: FlowState;
  now: number;
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  /** Tasks lit from outside (a panel row hovered, a Parent previewed): their tokens are ringed. */
  ringed?: string | readonly string[] | null;
  onOpenTask?: (key: string) => void;
  /** The viewer: whose questions and which takeable Tasks the chain's "First:" names. */
  me?: { id: string; takeable: ReadonlySet<string> };
  /** The button for a chain's first move: Answer, Claim. */
  actionFor?: (first: Chain["first"]) => ReactNode;
  orientation?: "auto" | "horizontal" | "vertical";
  /** Under this width (auto) the line runs down the page. */
  verticalBelow?: number;
  density?: "auto" | Density;
  /** Station heads as names with "+N" only. */
  compactHeads?: boolean;
  noBranch?: boolean;
  /** Under a vertical line: what follows it on a phone. */
  footer?: ReactNode;
  /** Leave the Loops list off, whatever the Workflow. */
  noLoops?: boolean;
  label?: string;
  className?: string;
};

const nobody = { id: "", takeable: new Set<string>() };

/**
 * A Project's Workflow as one line (Direction D): the Steps left to right in Workflow order, loops
 * back arced under it, forward skips dashed over it, the Steps Darkory files a Parent's own
 * Subtasks at on a branch "After a Parent"; every Task a token at its Step (beads past ~9 Steps or
 * narrow), a pickup tagged "now", a move travelling its Connector. Selecting a token draws its
 * Blocking chain and says what must end first. Below 640 px the line runs down the page.
 */
export function WorkflowLine(props: WorkflowLineProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.floor(el.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Laid out before it is measured (and under a test's DOM) at the drawing's own width.
  const w = width || 1198;
  const topology = useMemo(() => lineTopology(props.workflow), [props.workflow]);
  const vertical = props.orientation === "vertical" || (props.orientation !== "horizontal" && width > 0 && width < (props.verticalBelow ?? VERTICAL_BELOW));
  const density: Density = props.density && props.density !== "auto" ? props.density : densityFor(topology, w);
  const flow = props.flow ?? quiet;
  const all = props.all ?? props.tasks;
  const me = props.me ?? nobody;
  const [litLoop, setLitLoop] = useState<string | null>(null);
  const ring = props.ringed;
  const ringed = useMemo<ReadonlySet<string>>(() => new Set(typeof ring === "string" ? [ring] : (ring ?? [])), [ring]);

  const { onSelect, selected } = props;
  useEffect(() => {
    if (!selected || !onSelect) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onSelect(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, onSelect]);

  const heavy = !props.noLoops && !props.trace && (density === "beads" || topology.loops.length >= LOOPS_LISTED) && topology.loops.length > 0;
  const chain = useMemo(() => (vertical && selected ? chainOf(selected, all, me) : undefined), [vertical, selected, all, me]);

  return (
    <div ref={ref} role="region" aria-label={props.label ?? "Workflow line"} data-orientation={vertical ? "vertical" : "horizontal"} data-density={density} className={cn("w-full min-w-0", props.className)}>
      {vertical ? (
        <>
          <VerticalLine
            topology={topology}
            facts={props.workflow}
            tasks={props.tasks}
            hidden={props.hidden}
            done={props.done}
            ghosts={props.ghosts}
            branchLabel={props.branchLabel ?? "After a Parent"}
            doneToday={props.doneToday}
            trace={props.trace}
            flow={flow}
            now={props.now}
            selected={selected}
            onSelect={onSelect}
            ringed={ringed}
            onOpenTask={props.onOpenTask}
            compactHeads={props.compactHeads}
            noBranch={props.noBranch}
            footer={props.footer}
          />
          <Sheet open={!!chain} onOpenChange={(o) => !o && onSelect?.(null)}>
            <SheetContent side="bottom" className="p-4 pt-10">
              <SheetTitle className="sr-only">{chain ? `${chain.task.key} Blocking` : "Blocking"}</SheetTitle>
              {chain && <ChainCallout chain={chain} me={me.id} takeable={me.takeable} action={props.actionFor?.(chain.first)} onOpen={props.onOpenTask} now={props.now} />}
            </SheetContent>
          </Sheet>
        </>
      ) : (
        <HorizontalLine
          topology={topology}
          facts={props.workflow}
          width={w}
          density={density}
          tasks={props.tasks}
          all={all}
          hidden={props.hidden}
          done={props.done}
          ghosts={props.ghosts}
          branchLabel={props.branchLabel ?? "After a Parent"}
          fold={props.fold}
          doneToday={props.doneToday}
          trace={props.trace}
          flow={flow}
          now={props.now}
          selected={selected}
          onSelect={onSelect}
          ringed={ringed}
          onOpenTask={props.onOpenTask}
          me={me}
          actionFor={props.actionFor}
          compactHeads={props.compactHeads}
          litLoop={litLoop}
          noBranch={props.noBranch}
        />
      )}
      {heavy && !vertical && <LoopsList loops={topology.loops} onHover={setLitLoop} />}
    </div>
  );
}

/** The loops back by name, so each can be found without tracing a line; hovering one lights it. */
export function LoopsList({ loops, onHover }: { loops: readonly Loop[]; onHover?: (connectorId: string | null) => void }) {
  return (
    <section aria-label="Loops" className="border-t px-5 py-3">
      <h3 className="mb-1.5 flex items-baseline gap-2 text-[13px] font-semibold">
        Loops <span className="font-medium text-muted-foreground">{loops.length}</span>
      </h3>
      <ul className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
        {loops.map((l) => (
          <li
            key={l.connector.id}
            onMouseEnter={() => onHover?.(l.connector.id)}
            onMouseLeave={() => onHover?.(null)}
            className="grid h-[26px] grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2.5 rounded px-1 text-[12.5px] hover:bg-state-claimed-bg"
          >
            <span aria-hidden className="size-[7px] rotate-45 rounded-[2px] border-[1.5px] border-foreground" />
            <span className="truncate">
              {l.from} <span className="text-muted-foreground">↩</span> {l.to}
            </span>
            <span className="text-xs text-muted-foreground">{l.connector.name}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
