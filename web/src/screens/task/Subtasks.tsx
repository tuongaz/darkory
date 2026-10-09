// A Parent's Subtasks on its page and peek: on the Workflow line (where each stands, and what is
// still to come for the Parent), as a list, or as the Blocking among them (`?view=line|list|blocking`
// on the page; the choice is remembered by this browser; the line first).
import { GitForkIcon, ListIcon, ListPlusIcon, WorkflowIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { Task, TaskDetail } from "@/api/client";
import { useDirectory, useProjects, useRunnerSessions } from "@/api/queries";
import { findProject } from "@/app/currentProject";
import { usePeekLink } from "@/app/peek";
import { useSelectedTask } from "@/app/selection";
import { useNow } from "@/clock";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { SectionHeader } from "@/components/PageHeader";
import { Pill } from "@/components/Pill";
import { WorkGlyph } from "@/components/WorkGlyph";
import { BlockingView } from "@/components/workflow/blocking";
import { useLineData, WorkflowLine } from "@/components/workflowLine";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { kindLabel, liveClaim, taskWorkGlyph } from "@/work";
import { progressText } from "../board/derive";
import { useTaskWorkflow } from "./queries";

type SubtaskView = "list" | "line" | "blocking";
const viewKey = "darkory.task.subtasks";
const views: readonly string[] = ["list", "line", "blocking"];
/** `?view=graph`, the address the Subtask graph had, opens the Blocking that took its place. */
const asView = (v: string | null): SubtaskView | undefined => (v === "graph" ? "blocking" : v && views.includes(v) ? (v as SubtaskView) : undefined);

function remembered(): SubtaskView {
  try {
    return asView(localStorage.getItem(viewKey)) ?? "line";
  } catch {
    return "line";
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
  const asked = asView(params.get("view"));
  const view: SubtaskView = inAddress && asked ? asked : local;
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
              {seg("line", <WorkflowIcon aria-hidden />, "Line")}
              {seg("blocking", <GitForkIcon aria-hidden />, "Blocking")}
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
      {view === "line" ? (
        <ParentLine detail={detail} />
      ) : view === "blocking" ? (
        <ParentBlocking detail={detail} onShowOnLine={() => setView("line")} />
      ) : (
        <List subtasks={subtasks} />
      )}
    </section>
  );
}

/** The Blocking among the Parent's Subtasks, and what crosses into or out of it. */
function ParentBlocking({ detail, onShowOnLine }: { detail: TaskDetail; onShowOnLine: () => void }) {
  const project = findProject(useProjects().data ?? [], detail.task.project_id);
  if (!project) return null;
  return <BlockingView project={project} scope={detail.task.id} onShowOnLine={onShowOnLine} />;
}

/**
 * The Parent's Subtasks on its Project's line (r2-scope F2): each open one at its Step, those
 * ended Done green at Done, the rest of the Project a faint "+N" per Step, and on the branch what
 * is still to come for the Parent ("when 4 open end Done", "when MAIN-7 ends"). A Parent with
 * nothing on the main line any more folds it to a strip of names. A token opens its peek.
 */
function ParentLine({ detail }: { detail: TaskDetail }) {
  const { data } = useLineData(detail.task.project_id, undefined, detail.task.key);
  const now = useNow();
  const navigate = useNavigate();
  const peek = usePeekLink();
  const [selected, setSelected] = useState<string | null>(null);
  if (!data) return <div aria-busy className="h-[320px] rounded-md border" />;
  const s = data.scoped;
  return (
    <WorkflowLine
      label="Subtask line"
      className="rounded-md border px-2 pt-2 pb-1"
      workflow={data.facts}
      tasks={s.drawn}
      all={data.all}
      hidden={s.hidden}
      done={s.done}
      ghosts={s.ghosts}
      branchLabel={s.branchLabel}
      fold={s.fold}
      noLoops
      now={now}
      selected={selected}
      onSelect={setSelected}
      onOpenTask={(key) => navigate(peek(key))}
      me={data.me}
    />
  );
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
