import { useMutation } from "@tanstack/react-query";
import { EllipsisIcon, ExternalLinkIcon, MessageSquareIcon, SearchXIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router";
import { api, call, isUnauthenticated, ApiError, type TaskDetail } from "@/api/client";
import { useDirectory } from "@/api/queries";
import { teamTasksPath, useReportTeam } from "@/app/currentTeam";
import { Content, TopBar } from "@/app/TopBar";
import { EmptyState } from "@/components/EmptyState";
import { Key } from "@/components/Key";
import { SectionHeader } from "@/components/PageHeader";
import { Peek } from "@/components/Peek";
import { Pill } from "@/components/Pill";
import { Refusal } from "@/components/Refusal";
import { TeamMark } from "@/components/TeamMark";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import type { TaskActions } from "./actions";
import { featurePath, taskPath, useMemberName } from "./format";
import { ProposalCard, RetrospectiveObservations } from "./Proposal";
import { useTask } from "./queries";
import { useTaskActionsUI } from "./TaskActions";
import { TaskProperties } from "./TaskProperties";
import { TaskRecord } from "./TaskRecord";

const kinds = { work: undefined, breakdown: "Break down", retrospective: "Retrospective" } as const;

/** /tasks/:task: the Task's record in the main column, its facts in the 300px rail (F-T2). */
export function TaskPage() {
  const { task: ref = "" } = useParams();
  const q = useTask(ref);
  const ui = useTaskActionsUI(q.data, "default");
  const { teams } = useDirectory();
  const d = q.data;
  const team = d ? teams.get(d.feature.team_id) : undefined;
  useReportTeam(team?.key, "tasks");
  return (
    <>
      <TopBar
        crumbs={
          d
            ? [
                { label: team?.name ?? "Team", icon: team && <TeamMark team={team} />, to: team && teamTasksPath(team) },
                { label: d.feature.title, to: featurePath(d.feature.key) },
                { label: d.task.key },
              ]
            : [{ label: "Task" }, { label: ref }]
        }
        actions={ui.menu.length > 0 && <MoreMenu items={ui.menu} />}
        primary={ui.primary}
      />
      {d ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto lg:flex-row lg:overflow-hidden">
          <div className="min-w-0 flex-1 px-6 py-7 lg:overflow-auto lg:px-12">
            <TaskBody detail={d} actions={ui.actions} heading="h1" />
          </div>
          <aside aria-label="Properties" className="w-full flex-none border-t p-4 lg:w-[300px] lg:overflow-auto lg:border-t-0 lg:border-l">
            <TaskProperties detail={d} actions={ui.actions} grouped />
          </aside>
        </div>
      ) : (
        <Content pad>
          <TaskMissing query={q} />
        </Content>
      )}
      {ui.dialogs}
    </>
  );
}

/**
 * The Task opened over any page by ?task=<key>; the shell mounts it and closes it by dropping the
 * parameter (F-T1). The same sheet shows the next Task when the key changes.
 */
export function TaskPeek({ taskKey, onClose }: { taskKey: string; onClose: () => void }) {
  const q = useTask(taskKey);
  // Opened to answer it (the Inbox's Answer claims it first): the Note composer takes the focus.
  const answering = (useLocation().state as { note?: boolean } | null)?.note === true;
  const ui = useTaskActionsUI(q.data, "xs");
  const d = q.data;
  return (
    <>
      <Peek
        open
        onOpenChange={(o) => !o && onClose()}
        label={`Task ${taskKey}`}
        heading={<Key className="text-xs">{taskKey}</Key>}
        // The header is key · primary · ⋯ · ×; the page is the ⋯ menu's first item (F-T4).
        menu={[
          <DropdownMenuItem key="page" asChild>
            <Link to={taskPath(taskKey)}>
              <ExternalLinkIcon />
              Open as page
            </Link>
          </DropdownMenuItem>,
          ...(ui.menu.length > 0 ? [<DropdownMenuSeparator key="page-sep" />, ...ui.menu] : []),
        ]}
        actions={ui.primary}
      >
        {d ? (
          // Keyed, so a Note being written stays with its Task when J or K moves the peek on.
          <TaskBody
            key={d.task.id}
            detail={d}
            actions={ui.actions}
            heading="h2"
            properties={<TaskProperties detail={d} actions={ui.actions} />}
            focusNote={answering}
          />
        ) : (
          <TaskMissing query={q} />
        )}
      </Peek>
      {ui.dialogs}
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

/** What the peek and the page both show: the title, the facts (in the peek), the proposal, the record. */
function TaskBody({
  detail,
  actions,
  heading,
  properties,
  focusNote,
}: {
  detail: TaskDetail;
  actions: TaskActions;
  heading: "h1" | "h2";
  properties?: ReactNode;
  focusNote?: boolean;
}) {
  const { task, proposal } = detail;
  const H = heading;
  const kind = kinds[task.kind];
  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-col gap-1.5">
        {kind && (
          <Pill tone="secondary" className="w-fit">
            {kind}
          </Pill>
        )}
        <H className="text-xl leading-tight font-semibold tracking-[-0.01em] [overflow-wrap:anywhere]">{task.title}</H>
        {task.description && <p className="whitespace-pre-wrap">{task.description}</p>}
      </header>
      {properties}
      {proposal && <ProposalCard detail={detail} proposal={proposal} />}
      {task.kind === "retrospective" && <RetrospectiveObservations detail={detail} />}
      <section aria-label="Activity" className="flex flex-col gap-2">
        <SectionHeader title="Activity" />
        <TaskRecord detail={detail} />
        {actions.notes && "composer" in actions.notes && <NoteComposer detail={detail} autoFocus={focusNote} />}
        {actions.notes && "onlyHolder" in actions.notes && <OnlyHolder holder={actions.notes.onlyHolder} />}
      </section>
    </div>
  );
}

/** The holder's Note: the running log a Handover carries to the next Member. */
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

/** Only the holder may add a Note: anyone else sees that rule in the composer's place. */
function OnlyHolder({ holder }: { holder: string }) {
  const name = useMemberName();
  return (
    <p className="mt-2 flex h-9 items-center gap-2 rounded-md border border-dashed bg-muted px-3 text-muted-foreground">
      <MessageSquareIcon className="size-3.5" aria-hidden />
      Only {name(holder)} can add a Note
    </p>
  );
}
