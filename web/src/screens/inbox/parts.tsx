import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GitMergeIcon, LoaderIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, type To } from "react-router";
import { api, call, type Project, type Task, type TaskDetail } from "@/api/client";
import { keys, useDirectory, useLabels, useRunnerSessions } from "@/api/queries";
import { usePeekLink } from "@/app/peek";
import { useSelectedTask } from "@/app/selection";
import { useNow } from "@/clock";
import { Key } from "@/components/Key";
import { LabelPills } from "@/components/LabelPill";
import { Pill } from "@/components/Pill";
import { ProjectMark } from "@/components/ProjectMark";
import { Button } from "@/components/ui/button";
import { WorkGlyph } from "@/components/WorkGlyph";
import { cn } from "@/lib/utils";
import { kindLabel, taskWorkGlyph } from "@/work";
import { MergeDialog } from "@/screens/task/dialogs";
import { linkable } from "@/screens/task/pullRequest";
import { AnswerDialog } from "./AnswerDialog";
import { startOfDay } from "./derive";
import type { StepName } from "./queries";
import { refusalToast } from "./toast";

/** A section's band (kit `.group-h`): its name and how many rows it holds. */
export function GroupHeader({ title, count, actions }: { title: string; count?: number; actions?: ReactNode }) {
  return (
    <div className="flex h-[34px] items-center gap-2 border-b bg-muted pr-4 pl-4 font-medium md:pl-6">
      <h2>{title}</h2>
      {count !== undefined && <span className="font-normal text-muted-foreground tabular-nums">{count}</span>}
      {actions && <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
    </div>
  );
}

/** A line standing in for a section with nothing in it (kit `.none`). */
export function NoneLine({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <p className="flex min-h-11 items-center gap-2 border-b py-2 pr-4 pl-4 text-muted-foreground md:pl-6 [&_svg]:size-4 [&_svg]:flex-none">
      {icon}
      {children}
    </p>
  );
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const day = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const full = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** "22:18" today, "6 Oct" before; the full time on hover, naming what it is the time of. */
export function ShortTime({ at, what, className }: { at: string | undefined; what?: string; className?: string }) {
  const now = useNow();
  if (!at) return <span className={className} />;
  const d = new Date(at);
  return (
    <time dateTime={at} title={what ? `${what} ${full.format(d)}` : full.format(d)} className={cn("text-xs whitespace-nowrap text-muted-foreground tabular-nums", className)}>
      {d.getTime() >= startOfDay(now) ? clock.format(d) : day.format(d)}
    </time>
  );
}

/**
 * The link that makes a whole row open its record: it covers the row, so the row's own buttons
 * and links sit above it (`relative z-10`).
 */
export function RowLink({ to, children, className }: { to: To; children: ReactNode; className?: string }) {
  return (
    <Link to={to} className={cn("truncate font-medium outline-none after:absolute after:inset-0 focus-visible:underline", className)}>
      {children}
    </Link>
  );
}

/** A Task's derived state as its glyph: ended, a Parent's progress, its Claim and session, blocked, hold, waiting. */
export function TaskGlyph({ task }: { task: Task }) {
  const now = useNow();
  const { members } = useDirectory();
  const session = useRunnerSessions().data?.items.find((s) => s.task_id === task.id)?.state;
  return <WorkGlyph glyph={taskWorkGlyph(task, now, (id) => members.get(id)?.kind, session)} />;
}

/** Where a Task stands, in a word: its Step, "With <member>" when aimed, or a Parent's progress. */
export function StandsAt({ task, steps, me }: { task: Task; steps: Map<string, StepName>; me?: string }) {
  const { members } = useDirectory();
  if (task.subtask_counts) {
    const c = task.subtask_counts;
    return <span className="tabular-nums">{`${c.done}/${c.open + c.done + c.dropped}`}</span>;
  }
  if (task.step_id) return <span className="truncate">{steps.get(task.step_id)?.name ?? "a Step"}</span>;
  if (task.aimed_at_id) return <span className="truncate">{task.aimed_at_id === me ? "With you" : `With ${members.get(task.aimed_at_id)?.name ?? "a Member"}`}</span>;
  return null;
}

/** A Task's kind as a chip, for the Tasks Darkory files, unless the title already says it. */
export function KindPill({ task }: { task: Task }) {
  const label = kindLabel(task);
  return label ? <Pill tone="secondary">{label}</Pill> : null;
}

// Kit `.irow` across Projects: glyph · Project and key · title · marks · where it stands · from
// or Skill · time · action, on one 36px line. On a phone a row keeps the glyph, the title (with
// its key under it) and the action.
const rowGrid =
  "relative grid min-h-9 grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-2.5 border-b py-1 pr-4 pl-4 hover:bg-accent md:h-9 md:grid-cols-[16px_96px_minmax(0,1fr)_auto_120px_160px_52px_84px] md:py-0 md:pl-6";
const wide = "hidden md:flex";

/**
 * One Task as the Inbox and My work list it, with its Project's mark before its key: the lists
 * cross Projects. The title opens its peek over the page, which reports its Project to the shell.
 * The row joins the J/K walk (`data-task`).
 */
export function TaskRow({
  task,
  project,
  stands,
  marks,
  by,
  when,
  whenWhat,
  action,
  phone,
}: {
  task: Task;
  project: Project | undefined;
  /** What a phone's second line says after the key, where the wide columns fold away. */
  phone?: ReactNode;
  stands?: ReactNode;
  marks?: ReactNode;
  by?: ReactNode;
  when?: string;
  whenWhat?: string;
  action?: ReactNode;
}) {
  const peek = usePeekLink();
  const selected = useSelectedTask() === task.key;
  // The Labels its Project's Tasks can carry, read once per Project and shared with its pages.
  const carried = useLabels(project?.key).data;
  const labels = useMemo(() => new Map((carried ?? []).map((l) => [l.id, l])), [carried]);
  return (
    <div data-task={task.key} tabIndex={-1} className={cn(rowGrid, "outline-none", selected && "ring-2 ring-ring ring-inset")}>
      <TaskGlyph task={task} />
      <span className={cn(wide, "min-w-0 items-center gap-1.5")} title={project?.name}>
        {project && <ProjectMark project={project} />}
        <Key>{task.key}</Key>
      </span>
      <span className="flex min-w-0 flex-col md:flex-row md:items-center md:gap-2">
        <RowLink to={peek(task.key)}>{task.title}</RowLink>
        {project && <LabelPills ids={task.labels} labels={labels} className="hidden md:flex" />}
        <span data-phone-line className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground md:hidden">
          {project && <ProjectMark project={project} />}
          <span className="flex-none whitespace-nowrap">{task.key}</span>
          {stands && <span aria-hidden>·</span>}
          {stands}
          {phone}
        </span>
      </span>
      <span className={cn(wide, "items-center gap-1.5")}>{marks}</span>
      <span className={cn(wide, "min-w-0 items-center gap-1.5 text-muted-foreground")}>{stands}</span>
      <span className={cn(wide, "min-w-0 items-center gap-1.5 whitespace-nowrap text-muted-foreground")}>{by}</span>
      <ShortTime className="hidden text-right md:block" at={when} what={whenWhat} />
      <span className="flex justify-end">{action}</span>
    </div>
  );
}

/** Claims the Task as the signed-in Member, with no expiry; a refusal is a toast. */
export function ClaimButton({ task, primary }: { task: Task; primary?: boolean }) {
  const claim = useMutation({
    mutationFn: () => call(api.POST("/v1/tasks/{task}/claim", { params: { path: { task: task.key } }, body: {} })),
    onError: refusalToast,
  });
  return (
    <Button
      size="xs"
      variant={primary ? "default" : "outline"}
      className="relative z-10"
      disabled={claim.isPending}
      aria-label={`Claim ${task.key}`}
      onClick={() => claim.mutate()}
    >
      Claim
    </Button>
  );
}

/** Answers a question aimed at me: opens the dialog that claims it and completes it with the answer. */
export function AnswerButton({ task, primary }: { task: Task; primary?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant={primary ? "default" : "outline"} className="relative z-10" aria-label={`Answer ${task.key}`} onClick={() => setOpen(true)}>
        Answer
      </Button>
      <AnswerDialog task={task} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** Completes a Parent its Owner decides is done; a refusal (a Subtask opened meanwhile) is a toast. */
export function CompleteButton({ task, primary }: { task: Task; primary?: boolean }) {
  const complete = useMutation({
    mutationFn: () => call(api.POST("/v1/tasks/{task}/complete", { params: { path: { task: task.key } }, body: {} })),
    onError: refusalToast,
  });
  return (
    <Button
      size="xs"
      variant={primary ? "default" : "outline"}
      className="relative z-10"
      disabled={complete.isPending}
      aria-label={`Complete ${task.key}`}
      onClick={() => complete.mutate()}
    >
      Complete
    </Button>
  );
}

/** Opens the Task's peek, where its Owner decides: for a decision the row cannot make in one click. */
export function OpenButton({ task, label = "Open" }: { task: Task; label?: string }) {
  const peek = usePeekLink();
  return (
    <Button asChild size="xs" variant="outline" className="relative z-10">
      <Link to={peek(task.key)} aria-label={`${label} ${task.key}`}>
        {label}
      </Link>
    </Button>
  );
}

/**
 * The act on a Done Task whose pull request is open. With a Runner attached to the server, Merge:
 * it reads the Task's record for the branch it lands on (pending meanwhile; a failed read is a
 * toast), then the confirm names that branch, the Runner merges on GitHub, and a refusal is a
 * toast in GitHub's words. Without one, the act is the pull request itself, opened on GitHub.
 */
export function MergeAct({ task, primary }: { task: Task; primary?: boolean }) {
  const runner = useRunnerSessions().data?.runner;
  const qc = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [record, setRecord] = useState<TaskDetail>();
  const read = () => {
    setLoading(true);
    qc.fetchQuery({ queryKey: keys.task(task.key), queryFn: () => call(api.GET("/v1/tasks/{task}", { params: { path: { task: task.key } } })) })
      .then(setRecord, refusalToast)
      .finally(() => setLoading(false));
  };
  const pr = task.pull_request;
  if (!pr) return null;
  if (!runner) {
    const href = linkable(pr.url);
    // An address that is not https is not linked, as the chip does not link it.
    if (!href) return <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">#{pr.number} open</span>;
    return (
      <Button asChild size="xs" variant={primary ? "default" : "outline"} className="relative z-10">
        <a href={href} target="_blank" rel="noreferrer noopener">
          Open #{pr.number}
        </a>
      </Button>
    );
  }
  return (
    <>
      <Button
        size="xs"
        variant={primary ? "default" : "outline"}
        className="relative z-10"
        aria-label={`Merge ${task.key}`}
        aria-busy={loading || undefined}
        disabled={loading}
        onClick={read}
      >
        {loading ? <LoaderIcon aria-hidden className="animate-spin" /> : <GitMergeIcon />}
        Merge
      </Button>
      {record && <MergeDialog detail={record} open onOpenChange={(o) => !o && setRecord(undefined)} onRefused={refusalToast} />}
    </>
  );
}
