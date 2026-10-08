// A Parent's Subtasks on its page and peek: as a list, or as a graph over its Project's Steps
// with Blocking arrows (`?view=graph` on the page; the choice is remembered by this browser).
import { ListIcon, ListPlusIcon, WorkflowIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { Task, TaskDetail } from "@/api/client";
import { useDirectory, useOpenTasks, useRunnerSessions } from "@/api/queries";
import { usePeekLink } from "@/app/peek";
import { useSelectedTask } from "@/app/selection";
import { useNow } from "@/clock";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { SectionHeader } from "@/components/PageHeader";
import { Pill } from "@/components/Pill";
import { WorkGlyph } from "@/components/WorkGlyph";
import { SubtaskGraph } from "@/components/workflow/SubtaskGraph";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { kindLabel, liveClaim, taskWorkGlyph } from "@/work";
import { progressText } from "../board/derive";
import { graphSteps, graphSubtasks } from "./graph";
import { useTaskWorkflow } from "./queries";

type SubtaskView = "list" | "graph";
const viewKey = "darkory.task.subtasks";

function remembered(): SubtaskView {
  try {
    return localStorage.getItem(viewKey) === "graph" ? "graph" : "list";
  } catch {
    return "list";
  }
}

function remember(v: SubtaskView) {
  try {
    localStorage.setItem(viewKey, v);
  } catch {
    // Storage refused: the choice holds on this page.
  }
}

/**
 * Which view of the Subtasks shows: on the page the address says (`?view=graph`), else what this
 * browser chose last; in the peek, over a page whose `?view=` is its own, the browser's choice.
 */
function useSubtaskView(inAddress: boolean): [SubtaskView, (v: SubtaskView) => void] {
  const [params, setParams] = useSearchParams();
  const [local, setLocal] = useState<SubtaskView>(remembered);
  const asked = params.get("view");
  const view: SubtaskView = inAddress && (asked === "graph" || asked === "list") ? asked : local;
  const set = (v: SubtaskView) => {
    remember(v);
    setLocal(v);
    if (inAddress)
      setParams(
        (p) => {
          const next = new URLSearchParams(p);
          next.set("view", v);
          return next;
        },
        { replace: true },
      );
  };
  return [view, set];
}

export function Subtasks({ detail, onAdd, page }: { detail: TaskDetail; onAdd?: () => void; page: boolean }) {
  const { task, subtasks } = detail;
  const [view, setView] = useSubtaskView(page);
  const counts = task.subtask_counts;
  const seg = (v: SubtaskView, icon: ReactNode, label: string) => (
    <button
      type="button"
      aria-pressed={view === v}
      onClick={() => setView(v)}
      className={cn(
        "inline-flex h-[22px] items-center gap-1.5 rounded-[5px] px-2 text-xs font-medium text-muted-foreground [&_svg]:size-3.5",
        view === v && "bg-background text-foreground shadow-soft",
      )}
    >
      {icon}
      {label}
    </button>
  );
  return (
    <section aria-label="Subtasks" className="flex flex-col gap-2">
      <SectionHeader
        title={
          <span className="flex items-baseline gap-2">
            Subtasks
            {counts && (
              <span className="font-normal text-muted-foreground tabular-nums">
                {progressText(counts)} done{counts.dropped ? ` · ${counts.dropped} dropped` : ""}
              </span>
            )}
          </span>
        }
        actions={
          <>
            <div role="group" aria-label="Subtasks as" className="inline-flex rounded-md bg-muted p-0.5">
              {seg("list", <ListIcon aria-hidden />, "List")}
              {seg("graph", <WorkflowIcon aria-hidden />, "Graph")}
            </div>
            {onAdd && (
              <Button variant="ghost" size="xs" onClick={onAdd}>
                <ListPlusIcon />
                Add Subtask
              </Button>
            )}
          </>
        }
      />
      {view === "graph" ? <Graph detail={detail} /> : <List subtasks={subtasks} />}
    </section>
  );
}

function Graph({ detail }: { detail: TaskDetail }) {
  const { members, skills } = useDirectory();
  const now = useNow();
  const { steps } = useTaskWorkflow(detail.task.project_id);
  const runner = useRunnerSessions().data?.items;
  // The Organisation's open Tasks: which of them a Subtask blocks from outside the Parent.
  const open = useOpenTasks().data;
  const navigate = useNavigate();
  const peek = usePeekLink();
  const sessions = useMemo(() => new Map((runner ?? []).map((s) => [s.task_id, s])), [runner]);
  const columns = useMemo(() => graphSteps(steps, skills), [steps, skills]);
  // Live: the clock moves a lapse, the Runner a session's state.
  const nodes = useMemo(() => graphSubtasks(detail.subtasks, { members, now, sessions, open }), [detail.subtasks, members, now, sessions, open]);
  const keyOf = new Map(nodes.flatMap((n) => [[n.id, n.key] as const, ...(n.outside ?? []).map((o) => [o.id, o.key] as const)]));
  return <SubtaskGraph steps={columns} subtasks={nodes} onOpen={(id) => keyOf.get(id) && navigate(peek(keyOf.get(id)!))} className="rounded-md border" />;
}

function List({ subtasks }: { subtasks: Task[] }) {
  return (
    <ul className="flex flex-col">
      {subtasks.map((s) => (
        <SubtaskRow key={s.id} task={s} />
      ))}
    </ul>
  );
}

function SubtaskRow({ task }: { task: Task }) {
  const peek = usePeekLink();
  const now = useNow();
  const { members } = useDirectory();
  const selected = useSelectedTask() === task.key;
  const runner = useRunnerSessions().data?.items;
  const session = runner?.find((r) => r.task_id === task.id)?.state;
  const glyph = taskWorkGlyph(task, now, (id) => members.get(id)?.kind, session);
  const claim = liveClaim(task, now);
  const holder = claim ? members.get(claim.holder_id) : undefined;
  const aimed = !holder && task.aimed_at_id ? members.get(task.aimed_at_id) : undefined;
  const ended = task.state !== "open";
  const kind = kindLabel(task);
  const detail = useStepName(task);
  return (
    <li>
      <Link
        to={peek(task.key)}
        aria-label={`${task.key} ${task.title}`}
        data-task={task.key}
        className={cn(
          "grid h-9 grid-cols-[14px_56px_minmax(0,1fr)_auto] items-center gap-2.5 border-b px-2 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
          ended && "text-muted-foreground",
          selected && "ring-2 ring-ring ring-inset",
        )}
      >
        <WorkGlyph glyph={glyph} />
        <Key>{task.key}</Key>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn("min-w-0 truncate", !ended && "font-medium")}>{task.title}</span>
          {kind && <Pill tone="secondary">{kind}</Pill>}
          {task.blocked && !ended && <Pill tone="blocked">Blocked by {task.open_blockers?.[0]?.key}</Pill>}
        </span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {detail && <span className="hidden sm:inline">{detail}</span>}
          {(holder ?? aimed) && <MemberAvatar member={(holder ?? aimed)!} />}
        </span>
      </Link>
    </li>
  );
}

/** Where a Subtask stands, in words: its Step, the Member it waits with, or how it ended. */
function useStepName(task: Task): string | undefined {
  const { members } = useDirectory();
  const { steps } = useTaskWorkflow(task.project_id);
  if (task.state === "done") return "Done";
  if (task.state === "dropped") return "Dropped";
  if (task.step_id) return steps.find((s) => s.id === task.step_id)?.name;
  if (task.aimed_at_id) return `With ${members.get(task.aimed_at_id)?.name ?? "a Member"}`;
  return undefined;
}
