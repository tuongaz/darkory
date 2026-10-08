import { BotIcon, EllipsisIcon, PlusIcon } from "lucide-react";
import { useCallback, type MouseEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import type { Activity, Member, MemberDetail, Project, RunnerSession, Task, WorkflowStep } from "@/api/client";
import { useDirectory, useOpenTasks, useProject, useRunnerSessions, useWorkflow } from "@/api/queries";
import { projectPath, useRouteProject } from "@/app/currentProject";
import { projectCrumb } from "@/app/crumbs";
import { Content, TopBar } from "@/app/TopBar";
import { useNow } from "@/clock";
import { EmptyState } from "@/components/EmptyState";
import { HeartbeatMeter } from "@/components/HeartbeatMeter";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Pill } from "@/components/Pill";
import { PillsFit } from "@/components/PillsFit";
import { ProjectMark } from "@/components/ProjectMark";
import { Refusal } from "@/components/Refusal";
import { SessionStatePill } from "@/components/RunnerSessionBadge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { workingOf, type Working } from "@/lib/work";
import { cn } from "@/lib/utils";
import { useCurrentMe } from "@/me";
import { liveClaim } from "@/work";
import { AgentMenuItems, AgentPeek, EndPill } from "./AgentPeek";
import { agentActions, agentParam, taskOverAgents } from "./agentActions";
import { agentRows, lapsesIn24h, lastActivity, lastClaimEntry, type AgentRow } from "./derive";
import { GroupHeader, ShortTime } from "./parts";
import { useMemberDetails, useRecentActivity, useStepNames, useTaskMap } from "./queries";
import { useAgentActions } from "./useAgentActions";
import { describe, sentenceText, type Sentence } from "./wording";

// The columns a phone leaves out.
const wide = "hidden md:table-cell";

/** What an agent's standalone mark says: turning while its live Claim's session runs, else still in the session's colour. */
function workingMark(held: Task[], session: RunnerSession | undefined, now: number): Working | undefined {
  if (held.some((t) => liveClaim(t, now))) return workingOf("agent", session?.state);
  return session?.state === "ending" ? "ending" : undefined;
}

/**
 * /projects/:key/agents: the Project's agents, who is working now and is anyone stuck: what each
 * holds and at which Step, the session the Runner runs for it, its Skills and the Steps they let
 * it take here, and when it last did anything here. The Organisation's other agents follow,
 * muted, with their Projects. ?agent=<name> opens one agent's peek.
 */
export function AgentsPage() {
  const project = useRouteProject();
  const me = useCurrentMe();
  const now = useNow();
  const { memberList, members } = useDirectory();
  const detail = useProject(project.key);
  const workflow = useWorkflow(project.key).data;
  const open = useOpenTasks();
  const tasks = useTaskMap();
  const steps = useStepNames();
  const [params, setParams] = useSearchParams();
  const selected = params.get(agentParam);

  const runner = useRunnerSessions().data?.items ?? [];
  const inProject = new Set((detail.data?.members ?? []).map((m) => m.id));
  // The Project's Members carry no agent settings; the Organisation's list does.
  const agents = memberList.filter((m) => m.kind === "agent" && inProject.has(m.id));
  const others = memberList.filter((m) => m.kind === "agent" && !inProject.has(m.id) && !m.deactivated_at);
  const rows = agentRows(agents, open.data ?? [], now, (id) => runner.find((s) => s.member_id === id)?.state);
  const ids = rows.map((r) => r.agent.id);
  const details = useMemberDetails([...ids, ...others.map((m) => m.id)]);
  const detailOf = new Map(details.flatMap((q) => (q.data ? [[q.data.member.id, q.data] as const] : [])));
  const history = useRecentActivity({ project: project.key }, () => false);

  const openPeek = useCallback(
    (name: string) =>
      setParams((p) => {
        const next = new URLSearchParams(p);
        next.set(agentParam, name);
        next.delete("task");
        return next;
      }),
    [setParams],
  );
  const closePeek = useCallback(
    () =>
      setParams((p) => {
        const next = new URLSearchParams(p);
        next.delete(agentParam);
        return next;
      }),
    [setParams],
  );

  const failed = detail.error ?? open.error;
  return (
    <>
      <TopBar
        crumbs={[projectCrumb(project), { label: "Agents" }]}
        primary={
          me.member.admin && (
            <Button asChild>
              <Link to="/settings/organisation/agents?new=1">
                <PlusIcon />
                <span className="hidden sm:inline">New agent</span>
              </Link>
            </Button>
          )
        }
      />
      <Content>
        <h1 className="sr-only">Agents</h1>
        {failed ? (
          <Refusal error={failed} className="px-6 py-5" />
        ) : detail.isPending || open.isPending || memberList.length === 0 ? (
          <div className="flex flex-col gap-2 px-6 py-5" aria-busy>
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : (
          <>
            {rows.length === 0 ? (
              <EmptyState
                icon={<BotIcon />}
                title="No agents here"
                action={
                  me.member.admin && (
                    <Button asChild variant="outline">
                      <Link to={`/settings/projects/${encodeURIComponent(project.key)}/members`}>Add a Member</Link>
                    </Button>
                  )
                }
              >
                {project.name} has no agent Member yet.
              </EmptyState>
            ) : (
              // On a phone the table keeps Agent and Holds, and fits the screen; the rest is in the
              // agent's peek.
              <table className="w-full table-fixed border-collapse md:min-w-[1080px]">
                <thead>
                  <tr className="h-9 border-b text-left text-xs font-medium text-muted-foreground [&>th]:px-2.5 [&>th]:font-medium [&>th:first-child]:pl-4 md:[&>th:first-child]:pl-6">
                    <th className="w-[132px] md:w-[168px]">Agent</th>
                    <th>Holds</th>
                    <th className={cn(wide, "w-[200px]")}>Session</th>
                    <th className={cn(wide, "w-[200px]")}>Skills · Steps</th>
                    <th className={cn(wide, "w-[200px]")}>Last here</th>
                    <th className={cn(wide, "w-12")}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <AgentTableRow
                      key={row.agent.id}
                      row={row}
                      project={project}
                      detail={detailOf.get(row.agent.id)}
                      runnerSession={runner.find((s) => s.member_id === row.agent.id)}
                      takes={(workflow?.steps ?? []).filter((s) => s.takers.some((t) => t.id === row.agent.id))}
                      history={history.entries}
                      selected={selected === row.agent.name}
                      onOpen={openPeek}
                      me={me.member}
                      members={members}
                      tasks={tasks}
                      stepName={(id) => steps.get(id)?.name}
                    />
                  ))}
                </tbody>
              </table>
            )}
            {others.length > 0 && (
              <section aria-label="Also in other Projects" className="mt-6 text-muted-foreground">
                <GroupHeader title="Also in other Projects" count={others.length} />
                <ul>
                  {others.map((a) => (
                    <li key={a.id} className="flex min-h-10 flex-wrap items-center gap-x-2.5 gap-y-1 border-b py-1.5 pr-4 pl-4 md:pl-6">
                      <MemberAvatar member={a} className="opacity-70" />
                      <span className="font-medium">{a.name}</span>
                      <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs">
                        {(detailOf.get(a.id)?.projects ?? []).map((p) => (
                          <Link key={p.id} to={projectPath(p, "agents")} className="inline-flex items-center gap-1 hover:text-foreground hover:underline">
                            <ProjectMark project={p} className="opacity-70" />
                            {p.name}
                          </Link>
                        ))}
                        {detailOf.get(a.id)?.projects.length === 0 && <span>in no Project</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </Content>
      {selected && <AgentPeek key={selected} name={selected} project={project} onClose={closePeek} />}
    </>
  );
}

function AgentTableRow({
  row,
  project,
  detail,
  runnerSession,
  takes,
  history,
  selected,
  onOpen,
  me,
  members,
  tasks,
  stepName,
}: {
  row: AgentRow;
  project: Project;
  detail: MemberDetail | undefined;
  runnerSession: RunnerSession | undefined;
  takes: WorkflowStep[];
  history: Activity[];
  selected: boolean;
  onOpen: (name: string) => void;
  me: Member;
  members: Map<string, Member>;
  tasks: Map<string, Task>;
  stepName: (id: string) => string | undefined;
}) {
  const now = useNow();
  const { agent, held } = row;
  const task = held[0];
  const claim = task && liveClaim(task, now);
  const idle = !claim;
  const sessionTask = runnerSession && (tasks.get(runnerSession.task_id) ?? held.find((t) => t.id === runnerSession.task_id));
  const actions = agentActions({ agent, held, me, members, session: runnerSession, sessionKey: sessionTask?.key, project });
  const { run, dialog } = useAgentActions(agent);
  const lapses = lapsesIn24h(history, agent.id, now);
  // Why an idle agent holds nothing, said once: deactivated, paused, or how its last Claim here ended.
  const lastClaim = lastClaimEntry(history, agent.id);
  const ended = idle && lastClaim && lastClaim.kind !== "task.claimed" ? lastClaim : undefined;
  const endedKey = ended ? tasks.get(ended.subject_id)?.key : undefined;
  let why: ReactNode = null;
  if (idle && agent.deactivated_at) why = <Pill tone="dropped">Deactivated</Pill>;
  else if (ended && endedKey) {
    why = (
      <>
        <Key to={taskOverAgents(project, endedKey)}>{endedKey}</Key>
        <EndPill end={ended} when />
      </>
    );
  }
  const { skills, projects } = useDirectory();
  const last = lastActivity(history, agent.id);
  const lastWords = last && describe(last, { members, skills, tasks, stepName, projects, claims: new Map() });
  const otherProjects = (detail?.projects ?? []).filter((p) => p.id !== project.id);

  const open = (e: MouseEvent) => {
    // A click on a link or a button inside the row does its own thing.
    if ((e.target as HTMLElement).closest("a, button, [role=menuitem]")) return;
    onOpen(agent.name);
  };

  return (
    <tr
      onClick={open}
      aria-selected={selected}
      className={cn(
        "group h-[58px] cursor-pointer border-b hover:bg-accent [&>td]:px-2.5 [&>td]:py-2 [&>td:first-child]:pl-4 md:[&>td:first-child]:pl-6",
        idle && "text-muted-foreground",
        selected && "bg-accent [&>td:first-child]:shadow-[inset_2px_0_0_var(--primary)]",
      )}
    >
      <td>
        <span className="flex min-w-0 items-center gap-2">
          <MemberAvatar member={agent} size="md" working={workingMark(held, runnerSession, now)} className={cn(idle && !runnerSession && "opacity-60")} />
          <span className="flex min-w-0 flex-col">
            <Link
              to={{ search: `?${agentParam}=${encodeURIComponent(agent.name)}` }}
              onClick={(e) => {
                e.preventDefault();
                onOpen(agent.name);
              }}
              className={cn("truncate font-medium hover:underline", !idle && "text-foreground")}
            >
              {agent.name}
            </Link>
            {(agent.agent?.paused || otherProjects.length > 0) && (
              <small className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                {agent.agent?.paused && <Pill tone="secondary">Paused</Pill>}
                {otherProjects.length > 0 && <span className="truncate" title={otherProjects.map((p) => p.name).join(", ")}>also {otherProjects.map((p) => p.key).join(" · ")}</span>}
              </small>
            )}
          </span>
        </span>
      </td>
      <td>
        {claim ? (
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <Key to={taskOverAgents(project, task.key)}>{task.key}</Key>
              <span className="truncate font-medium text-foreground">{task.title}</span>
              {held.length > 1 && <span className="text-xs whitespace-nowrap text-muted-foreground">+{held.length - 1}</span>}
            </span>
            <small className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {task.step_id && <span className="truncate">{stepName(task.step_id) ?? "a Step"}</span>}
              {task.blocked && task.open_blockers?.[0] && <Pill tone="blocked">Blocked by {task.open_blockers[0].key}</Pill>}
              {claim.expires_at && <HeartbeatMeter claim={claim} variant="compact" />}
            </small>
          </span>
        ) : (
          <span className="flex min-w-0 flex-col gap-0.5">
            <span>Nothing held</span>
            {/* A dimmed row says why, in one pill. */}
            {why && <small className="flex min-w-0 items-center gap-1.5 text-xs">{why}</small>}
          </span>
        )}
      </td>
      <td className={wide}>
        {runnerSession ? (
          <span className="flex min-w-0 flex-col items-start gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <SessionStatePill state={runnerSession.state} />
              {sessionTask && sessionTask.id !== task?.id && <Key to={taskOverAgents(project, sessionTask.key)}>{sessionTask.key}</Key>}
            </span>
            <small className="flex max-w-full min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <span className="truncate">{runnerSession.host}</span>
              <span aria-hidden>·</span>
              {runnerSession.tmux ? <span className="truncate font-mono">{runnerSession.tmux}</span> : <span>no tmux</span>}
            </small>
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">{agent.agent ? "No session" : "Not run by the Runner"}</span>
        )}
      </td>
      <td className={wide}>
        <span className="flex min-w-0 flex-col gap-0.5">
          <PillsFit names={detail?.skills.map((s) => s.name) ?? []} />
          <small className="truncate text-xs text-muted-foreground" title={takes.map((s) => s.name).join(", ")}>
            {takes.length > 0 ? takes.map((s) => s.name).join(" · ") : "takes no Step here"}
          </small>
        </span>
      </td>
      <td className={wide}>
        {last ? (
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-xs">{lastWords ? sentenceShort(lastWords) : last.kind}</span>
            <small className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShortTime at={last.at} />
              {lapses.length > 0 && <Pill tone="dropped">{lapses.length === 1 ? "1 lapse" : `${lapses.length} lapses`} in 24 h</Pill>}
            </small>
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">Nothing yet</span>
        )}
      </td>
      <td className={wide}>
        {actions.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                aria-label={`More for ${agent.name}`}
              >
                <EllipsisIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <AgentMenuItems actions={actions} run={run} />
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {dialog}
      </td>
    </tr>
  );
}

/** An Activity sentence without its actor or details, for the agent's own row: "advanced WEB-3 along pass to Review". */
function sentenceShort(s: Sentence): string {
  return sentenceText({ ...s, actorName: "", details: [] }).trim();
}
