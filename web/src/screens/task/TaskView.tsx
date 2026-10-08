import { useMutation } from "@tanstack/react-query";
import { EllipsisIcon, ExternalLinkIcon, MessageSquareIcon, SearchXIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router";
import { api, ApiError, call, isUnauthenticated, type RunnerSession, type TaskDetail } from "@/api/client";
import { useRunnerSession, useTask } from "@/api/queries";
import { projectPath, useReportProject } from "@/app/currentProject";
import { projectCrumb } from "@/app/crumbs";
import { Content, TopBar } from "@/app/TopBar";
import { EmptyState } from "@/components/EmptyState";
import { Key } from "@/components/Key";
import { SectionHeader } from "@/components/PageHeader";
import { Peek } from "@/components/Peek";
import { Pill } from "@/components/Pill";
import { Refusal } from "@/components/Refusal";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { taskBranch } from "@/lib/branch";
import { kindLabel } from "@/work";
import type { TaskActions } from "./actions";
import { taskPath as pagePath, useMemberName } from "./format";
import { LabelsEditor } from "./LabelsEditor";
import { MemberName } from "./parts";
import { ProposalCard, RetrospectiveObservations } from "./Proposal";
import { useTaskPath, useTaskWorkflow } from "./queries";
import { useSessionActions } from "./SessionActions";
import { SessionPanel } from "./SessionPanel";
import { Stepper } from "./Stepper";
import { Subtasks } from "./Subtasks";
import { TaskLine } from "./TaskLine";
import { useTaskActionsUI, type TaskActionsUI } from "./TaskActions";
import { Branch, ParentLink, Standing, TaskProperties } from "./TaskProperties";
import { TaskRecord } from "./TaskRecord";

/** /tasks/:task: the Task's record in the main column, its Claim and Blocking in the 300px rail. */
export function TaskPage() {
  const { task: ref = "" } = useParams();
  const q = useTask(ref);
  const d = q.data;
  useReportProject(d?.task.project_id);
  const ui = useTaskActionsUI(d, "default");
  const session = useRunnerSession(d?.task.id);
  const runner = useSessionActions(d, session);
  const { project, steps } = useTaskWorkflow(d?.task.project_id);
  const menu = [...ui.menu, ...(ui.menu.length > 0 && runner.menu.length > 0 ? [<DropdownMenuSeparator key="session-sep" />] : []), ...runner.menu];
  return (
    <>
      <TopBar
        crumbs={
          project
            ? [projectCrumb(project), { label: "Tasks", to: projectPath(project, "tasks"), wide: true }, { label: d?.task.key ?? ref }]
            : [{ label: "Task" }, { label: ref }]
        }
        actions={menu.length > 0 && <MoreMenu items={menu} />}
        primary={ui.primary}
      />
      {d ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto lg:flex-row lg:overflow-hidden">
          <div className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:overflow-auto lg:px-12 lg:py-7">
            <TaskBody detail={d} ui={ui} heading="h1" session={session} steps={steps} />
          </div>
          <aside aria-label="Properties" className="w-full flex-none border-t p-4 lg:w-[300px] lg:overflow-auto lg:border-t-0 lg:border-l">
            <TaskProperties detail={d} steps={steps} grouped />
          </aside>
        </div>
      ) : (
        <Content pad>
          <TaskMissing query={q} />
        </Content>
      )}
      {ui.dialogs}
      {runner.dialogs}
    </>
  );
}

/**
 * The Task opened over any page by ?task=<key>; the shell mounts it and closes it by dropping the
 * parameter. The same sheet shows the next Task when the key changes.
 */
export function TaskPeek({ taskKey, onClose }: { taskKey: string; onClose: () => void }) {
  const q = useTask(taskKey);
  const d = q.data;
  useReportProject(d?.task.project_id);
  // Opened to answer it (the Inbox's Answer claims it first): the Note composer takes the focus.
  const answering = (useLocation().state as { note?: boolean } | null)?.note === true;
  const ui = useTaskActionsUI(d, "xs");
  const session = useRunnerSession(d?.task.id);
  const runner = useSessionActions(d, session);
  const { steps } = useTaskWorkflow(d?.task.project_id);
  return (
    <>
      <Peek
        open
        onOpenChange={(o) => !o && onClose()}
        label={`Task ${taskKey}`}
        heading={<Key to={pagePath(taskKey)} className="text-xs">{taskKey}</Key>}
        // The header is key · primary · ⋯ · ×; the page is the ⋯ menu's first item.
        menu={[
          <DropdownMenuItem key="page" asChild>
            <Link to={pagePath(taskKey)}>
              <ExternalLinkIcon />
              Open as page
            </Link>
          </DropdownMenuItem>,
          ...(ui.menu.length > 0 ? [<DropdownMenuSeparator key="page-sep" />, ...ui.menu] : []),
          ...(runner.menu.length > 0 ? [<DropdownMenuSeparator key="session-sep" />, ...runner.menu] : []),
        ]}
        actions={ui.primary}
      >
        {d ? (
          // Keyed, so a Note being written stays with its Task when J or K moves the peek on.
          <TaskBody
            key={d.task.id}
            detail={d}
            ui={ui}
            heading="h2"
            properties={<TaskProperties detail={d} steps={steps} />}
            focusNote={answering}
            session={session}
            steps={steps}
          />
        ) : (
          <TaskMissing query={q} />
        )}
      </Peek>
      {ui.dialogs}
      {runner.dialogs}
    </>
  );
}

function MoreMenu({ items }: { items: ReactNode[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="More">
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{items}</DropdownMenuContent>
    </DropdownMenu>
  );
}

function TaskMissing({ query }: { query: ReturnType<typeof useTask> }) {
  if (query.isPending) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (query.error instanceof ApiError && query.error.code === "not_found") {
    return (
      <EmptyState icon={<SearchXIcon />} title="No such Task">
        Nothing has this key.
      </EmptyState>
    );
  }
  return isUnauthenticated(query.error) ? null : <Refusal error={query.error} />;
}

const stateTone = { open: undefined, done: "done", dropped: "dropped" } as const;

/** A dot between the facts of the header's line. */
function Sep() {
  return <span aria-hidden className="h-3.5 w-px bg-border" />;
}

/**
 * The head of a Task: its kind, title and description; a line of facts (where it stands, its
 * Parent, Owner, Rank, Auto-complete and Acceptance, branch); its Labels; its path through the Steps.
 */
function TaskHeader({ detail, ui, heading, steps, path }: { detail: TaskDetail; ui: TaskActionsUI; heading: "h1" | "h2"; steps: Parameters<typeof Stepper>[0]["steps"]; path: Parameters<typeof Stepper>[0]["path"] }) {
  const { task, parent } = detail;
  const H = heading;
  const kind = task.kind !== "work" ? (kindLabel(task) ?? { breakdown: "Breakdown", acceptance: "Acceptance", retrospective: "Retrospective" }[task.kind]) : undefined;
  const tone = stateTone[task.state];
  const topLevel = !task.parent_id;
  return (
    <header className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {heading === "h1" && <Key>{task.key}</Key>}
        {kind && <Pill tone="secondary">{kind}</Pill>}
        {task.aimed_at_id && task.state === "open" && <Pill tone="waiting">Question</Pill>}
      </div>
      <H className="text-xl leading-tight font-semibold tracking-[-0.01em] [overflow-wrap:anywhere]">{task.title}</H>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-muted-foreground">
        {tone && <Pill tone={tone}>{task.state === "done" ? "Done" : "Dropped"}</Pill>}
        {task.state === "open" && <Standing detail={detail} steps={steps} />}
        {parent && (
          <>
            <Sep />
            <ParentLink parent={parent} />
          </>
        )}
        <Sep />
        <span className="inline-flex min-w-0 items-center gap-1.5">
          Owner <MemberName id={task.owner_id} className="text-foreground" />
        </span>
        {topLevel && task.rank !== undefined && (
          <>
            <Sep />
            <span>
              Rank <b className="font-medium text-foreground">#{task.rank}</b>
            </span>
          </>
        )}
        {topLevel && (task.auto_complete || task.acceptance) && (
          <>
            <Sep />
            {task.auto_complete && <Pill tone="secondary">Auto-complete</Pill>}
            {task.acceptance && <Pill tone="secondary">Acceptance</Pill>}
          </>
        )}
        {detail.workspaces.length > 0 && (
          <>
            <Sep />
            <span className="inline-flex min-w-0 items-center text-foreground">
              <Branch name={taskBranch(task.key, task.title)} />
            </span>
          </>
        )}
      </div>
      <LabelsEditor detail={detail} editable={ui.actions.labels} />
      {task.subtask_counts || detail.subtasks.length > 0 ? (
        <Stepper detail={detail} path={path} steps={steps} />
      ) : (
        <>
          {/* The line is drawn for the eye; a screen reader reads the same path as a list. */}
          <div className="sr-only">
            <Stepper detail={detail} path={path} steps={steps} />
          </div>
          <TaskLine detail={detail} />
        </>
      )}
      {task.description && <p className="mt-1 whitespace-pre-wrap">{task.description}</p>}
    </header>
  );
}

/**
 * What the peek and the page both show: the head, the facts (in the peek), the Runner's session
 * while it runs one, a Parent's Subtasks, the proposals, the record and the Note composer.
 */
function TaskBody({
  detail,
  ui,
  heading,
  properties,
  focusNote,
  session,
  steps,
}: {
  detail: TaskDetail;
  ui: TaskActionsUI;
  heading: "h1" | "h2";
  properties?: ReactNode;
  focusNote?: boolean;
  session: RunnerSession | undefined;
  steps: Parameters<typeof Stepper>[0]["steps"];
}) {
  const { task } = detail;
  const path = useTaskPath(task.id);
  const actions: TaskActions = ui.actions;
  return (
    <div className="flex flex-col gap-7">
      <TaskHeader detail={detail} ui={ui} heading={heading} steps={steps} path={path} />
      {properties}
      {/* Keyed: another Task's page starts watching, whatever this one was joined to. */}
      {session && <SessionPanel key={task.id} detail={detail} session={session} tall={heading === "h1"} />}
      {(task.subtask_counts || detail.subtasks.length > 0) && <Subtasks detail={detail} onAdd={ui.addSubtask} page={heading === "h1"} />}
      {detail.proposals.map((p) => (
        <ProposalCard key={p.id} detail={detail} proposal={p} />
      ))}
      {task.kind === "retrospective" && <RetrospectiveObservations detail={detail} />}
      <section aria-label="Record" className="flex flex-col gap-2">
        <SectionHeader title="Record" />
        <TaskRecord detail={detail} path={path} steps={steps} />
        {actions.notes && "composer" in actions.notes && <NoteComposer detail={detail} autoFocus={focusNote} />}
        {actions.notes && "onlyHolder" in actions.notes && <OnlyHolder holder={actions.notes.onlyHolder} />}
      </section>
    </div>
  );
}

/** A Note: the holder's running log a Handover carries on, or a Project Member's on a Task nobody holds. */
function NoteComposer({ detail, autoFocus }: { detail: TaskDetail; autoFocus?: boolean }) {
  const [body, setBody] = useState("");
  const add = useMutation({
    mutationFn: () => call(api.POST("/v1/tasks/{task}/notes", { params: { path: { task: detail.task.id } }, body: { body: body.trim() } })),
    onSuccess: () => setBody(""),
  });
  return (
    <form
      className="mt-2 flex flex-col rounded-md border border-input bg-background focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50"
      onSubmit={(e) => {
        e.preventDefault();
        if (body.trim()) add.mutate();
      }}
    >
      <Textarea
        aria-label="Note"
        autoFocus={autoFocus}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && body.trim()) {
            e.preventDefault();
            add.mutate();
          }
        }}
        placeholder="Add a Note"
        className="min-h-16 resize-none border-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
      <div className="flex items-center gap-2 border-t px-2 py-1.5">
        <Refusal error={add.error} />
        <Button type="submit" variant="outline" size="xs" className="ml-auto" disabled={!body.trim() || add.isPending}>
          Add Note
        </Button>
      </div>
    </form>
  );
}

/** Only the holder may add a Note to a held Task: anyone else sees that rule in the composer's place. */
function OnlyHolder({ holder }: { holder: string }) {
  const name = useMemberName();
  return (
    <p className="mt-2 flex h-9 items-center gap-2 rounded-md border border-dashed bg-muted px-3 text-muted-foreground">
      <MessageSquareIcon className="size-3.5" aria-hidden />
      Only {name(holder)} can add a Note
    </p>
  );
}
