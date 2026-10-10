import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { quiet, type FlowState } from "@/components/workflow/live";
import { cn } from "@/lib/utils";
import { WayStrip } from "./Callout";
import { chainOf, type Chain, type Ghost, type Trace } from "./data";
import { lineTopology } from "./layout";
import { isHoldStep, type LineFacts, type LineTask } from "./model";
import { VerticalLine, type Way } from "./Vertical";
import { AFTER_BRANCH, HAND_LABEL } from "./words";

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
  /** Tasks that reached Done today: "1 today" beside Done. */
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
  /** Leave the quiet row "When a Parent ends" off (a Task's line off it). */
  noBranch?: boolean;
  /** Under the line: what follows it on a phone. */
  footer?: ReactNode;
  /** The Tasks list at a Step: where a Step's list links for the rest of its Tasks. */
  stepHref?: (stepId: string) => string;
  label?: string;
  className?: string;
};

const nobody = { id: "", takeable: new Set<string>() };

/**
 * A Project's Workflow as one line, top to bottom at every width (the final design, vf-1 … vf-6):
 * Start first, each Step a row, the outcomes on the rail, returns as tracks beside it, "Also starts
 * here" beside the start, the Steps where Darkory files a Parent's own Subtasks a quiet row "When a
 * Parent ends"; every Task a token at its Step, a pickup tagged "now". Selecting a token puts its
 * way in a strip above the line (vf-7): what it can do next, its Blocking chain and what must end
 * first; its way stays in full ink, its chain ringed, the rest fades.
 */
export function WorkflowLine(props: WorkflowLineProps) {
  const topology = useMemo(() => lineTopology(props.workflow), [props.workflow]);
  const flow = props.flow ?? quiet;
  const all = props.all ?? props.tasks;
  const me = props.me ?? nobody;
  const ring = props.ringed;
  const { onSelect, selected } = props;
  useEffect(() => {
    if (!selected || !onSelect) return;
    // An Escape something on the page already took (a Step's list closing) leaves the selection alone.
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && onSelect(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, onSelect]);

  const chain = useMemo(() => (selected ? chainOf(selected, all, me) : undefined), [selected, all, me]);
  // A question the chain waits on, with a Member at no Step: it stands with the chain.
  const aimed = chain?.upstream.flat().find((x) => x.aimedAt && !x.stepId);
  const inChain = useMemo(() => (chain ? new Set([chain.task.id, ...chain.upstream.flat().map((x) => x.id), ...chain.downstream.map((x) => x.id)]) : undefined), [chain]);
  // The chain's Tasks are ringed on the line, beside what is lit from outside.
  const ringed = useMemo<ReadonlySet<string>>(() => new Set([...(typeof ring === "string" ? [ring] : (ring ?? [])), ...(inChain ?? [])]), [ring, inChain]);

  const task = chain?.task;
  const nameOf = (id: string | null) => (id === null ? "Done" : (topology.others.get(id) ?? props.workflow.steps.find((s) => s.id === id)?.name ?? "a Step"));
  const next = (() => {
    const at = task?.stepId;
    if (!at) return [];
    const step = props.workflow.steps.find((s) => s.id === at);
    const hold = !!step && isHoldStep(step);
    // A hold's Connector names where a move by hand lands; a hold with none moves on by hand along
    // the rail, or, parked, into the start.
    const out = props.workflow.connectors
      .filter((c) => c.from === at)
      .sort((a, b) => a.position - b.position)
      .map((c) => ({ outcome: hold ? HAND_LABEL : c.name, to: nameOf(c.to) }));
    if (out.length > 0 || !hold) return out;
    const along = topology.segments.find((x) => x.from === at && x.hand)?.to ?? (topology.holds.includes(at) ? topology.start : undefined);
    return along ? [{ outcome: HAND_LABEL, to: nameOf(along) }] : [];
  })();
  // Its way in: its trace says it when the line traces it (its scope), else its Step is.
  const trace = props.trace;
  const traced = !!task && trace?.taskId === task.id;
  const way: Way | undefined =
    task && inChain
      ? {
          stepId: task.stepId,
          chain: inChain,
          entered: traced ? [...trace.traversed].reverse().find((id) => topology.entries.some((e) => e.connector.id === id)) : undefined,
          from: traced ? trace.stays[0]?.stepId : task.stepId,
        }
      : undefined;

  // The strip takes the focus when the viewer picked the Task on the line (a chip, a row of a
  // Step's list), not when a selection arrives from elsewhere or the Task moves on. Cleared, the
  // focus goes back to the Task's chip, or to the count it folded into, unless it has gone
  // elsewhere on the page.
  const box = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLElement>(null);
  const picked = useRef(false);
  const pick = useMemo(
    () =>
      onSelect &&
      ((id: string | null) => {
        picked.current = true;
        onSelect(id);
      }),
    [onSelect],
  );
  const back = useRef<{ key: string; stepId?: string } | null>(null);
  useEffect(() => {
    if (task) back.current = { key: task.key, stepId: task.stepId };
  });
  const selKey = task?.key;
  useEffect(() => {
    const byViewer = picked.current;
    picked.current = false;
    if (selKey) {
      // The key when it opens the Task, else the strip itself: never its action, which a key held down would press.
      if (byViewer) (strip.current?.querySelector<HTMLElement>("[data-way-key]") ?? strip.current)?.focus();
      return;
    }
    const was = back.current;
    back.current = null;
    const root = box.current;
    if (!was || !root) return;
    const active = document.activeElement;
    if (active && active !== document.body && !root.contains(active)) return;
    // Cleared: the Task's chip, or the count it folded into. Still selected but gone (Done, another
    // Workflow): the line.
    const to = selected ? null : (root.querySelector<HTMLElement>(`[data-box="token"][data-task="${was.key}"]`) ?? (was.stepId ? root.querySelector<HTMLElement>(`button[data-count="${was.stepId}"]`) : null));
    (to ?? root).focus();
  }, [selKey, selected]);

  return (
    <div ref={box} tabIndex={-1} role="region" aria-label={props.label ?? "Workflow line"} className={cn("w-full min-w-0 outline-none", props.className)}>
      {chain && (
        <WayStrip
          ref={strip}
          chain={chain}
          next={next}
          me={me.id}
          action={props.actionFor?.(chain.first)}
          aimed={aimed}
          onOpen={props.onOpenTask}
          onClear={() => onSelect?.(null)}
          now={props.now}
        />
      )}
      <VerticalLine
        topology={topology}
        facts={props.workflow}
        tasks={props.tasks}
        hidden={props.hidden}
        done={props.done}
        ghosts={props.ghosts}
        branchLabel={props.branchLabel ?? AFTER_BRANCH}
        doneToday={props.doneToday}
        trace={props.trace}
        flow={flow}
        now={props.now}
        selected={selected}
        onSelect={pick}
        ringed={ringed}
        way={way}
        onOpenTask={props.onOpenTask}
        noBranch={props.noBranch}
        footer={props.footer}
        stepHref={props.stepHref}
      />
    </div>
  );
}
