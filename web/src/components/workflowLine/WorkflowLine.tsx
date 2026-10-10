import { useEffect, useMemo, type ReactNode } from "react";
import { quiet, type FlowState } from "@/components/workflow/live";
import { MemberAvatar } from "@/components/MemberAvatar";
import { cn } from "@/lib/utils";
import { ChainCallout } from "./Callout";
import { chainOf, type Chain, type Ghost, type Trace } from "./data";
import { lineTopology } from "./layout";
import type { LineFacts, LineTask } from "./model";
import { VerticalLine } from "./Vertical";
import { AFTER_BRANCH } from "./words";

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
  /** Connectors drawn in the changed colour: what an edit changed. */
  highlight?: ReadonlySet<string>;
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
  label?: string;
  className?: string;
};

const nobody = { id: "", takeable: new Set<string>() };

/**
 * A Project's Workflow as one line, top to bottom at every width (the final design, vf-1 … vf-6):
 * Start first, each Step a row, the outcomes on the rail, returns as tracks beside it, "Also starts
 * here" beside the start, the Steps where Darkory files a Parent's own Subtasks a quiet row "When a
 * Parent ends"; every Task a token at its Step, a pickup tagged "now". Selecting a token says its
 * Blocking chain and what must end first.
 */
export function WorkflowLine(props: WorkflowLineProps) {
  const topology = useMemo(() => lineTopology(props.workflow), [props.workflow]);
  const flow = props.flow ?? quiet;
  const all = props.all ?? props.tasks;
  const me = props.me ?? nobody;
  const ring = props.ringed;
  const ringed = useMemo<ReadonlySet<string>>(() => new Set(typeof ring === "string" ? [ring] : (ring ?? [])), [ring]);

  const { onSelect, selected } = props;
  useEffect(() => {
    if (!selected || !onSelect) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onSelect(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, onSelect]);

  const chain = useMemo(() => (selected ? chainOf(selected, all, me) : undefined), [selected, all, me]);
  // A question the chain waits on, with a Member at no Step: it stands with the chain.
  const aimed = chain?.upstream.flat().find((x) => x.aimedAt && !x.stepId);

  return (
    <div role="region" aria-label={props.label ?? "Workflow line"} data-orientation="vertical" className={cn("w-full min-w-0", props.className)}>
      {chain && (
        <div role="dialog" aria-label={`${chain.task.key} Blocking`} className="mb-3 flex flex-col gap-2 rounded-lg border bg-popover px-3 py-2.5 text-popover-foreground shadow-pop">
          <ChainCallout chain={chain} me={me.id} takeable={me.takeable} action={props.actionFor?.(chain.first)} onOpen={props.onOpenTask} now={props.now} />
          {aimed?.aimedAt && (
            <span
              className="inline-flex h-[26px] w-max items-center gap-1.5 rounded-full border-[1.5px] border-dashed border-state-waiting bg-background pr-2.5 pl-1.5 text-xs whitespace-nowrap"
              aria-label={`${aimed.key} ${aimed.title}, with ${aimed.aimedAt.id === me.id ? "you" : aimed.aimedAt.name}`}
            >
              <MemberAvatar member={aimed.aimedAt} />
              <span className="font-mono text-[11.5px]">{aimed.key}</span>
              <span className="text-muted-foreground">with {aimed.aimedAt.id === me.id ? "you" : aimed.aimedAt.name}</span>
            </span>
          )}
        </div>
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
        onSelect={onSelect}
        ringed={ringed}
        onOpenTask={props.onOpenTask}
        highlight={props.highlight}
        noBranch={props.noBranch}
        footer={props.footer}
      />
    </div>
  );
}
