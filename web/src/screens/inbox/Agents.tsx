import { BotIcon, EllipsisIcon, PlusIcon } from "lucide-react";
import { useCallback, type MouseEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import type { Activity, Member, MemberDetail, Project, RunnerSession, Task } from "@/api/client";
import { useDirectory, useOpenTasks, useProject, useRunnerSessions, useWorkflow } from "@/api/queries";
import { projectPath, projectSettingsPath, useRouteProject } from "@/app/currentProject";
import { projectCrumb } from "@/app/crumbs";
import { BarAction, Content, TopBar } from "@/app/TopBar";
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
import { AgentMenuItems, AgentPeek, EndPill, QueueLines } from "./AgentPeek";
import { agentActions, agentParam, taskOverAgents } from "./agentActions";
import { aboutProject, agentRows, lapsesIn24h, lastActivity, lastClaimEntry, queueOf, takesOf, type AgentRow } from "./derive";
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

// A Shift that needs someone shows first: the agent's mark takes its colour.
const shiftOrder: Partial<Record<RunnerSession["state"], number>> = { stalled: 0, waiting: 1 };

/**
 * /projects/:key/agents: the Project's agents, who is working now and is anyone stuck: what each
 * holds and at which Step, the Shift the Runner runs for it, its Skills and the Steps they let
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
  // An agent may run several Shifts; the one that needs someone stands for it.
  const shiftsOf = (id: string) => runner.filter((s) => s.member_id === id).sort((a, b) => (shiftOrder[a.state] ?? 2) - (shiftOrder[b.state] ?? 2));
  const rows = agentRows(agents, open.data ?? [], now, (id) => shiftsOf(id)[0]?.state);
  const ids = rows.map((r) => r.agent.id);
  const details = useMemberDetails([...ids, ...others.map((m) => m.id)]);
  const detailOf = new Map(details.flatMap((q) => (q.data ? [[q.data.member.id, q.data] as const] : [])));
  const history = useRecentActivity({ project: project.key }, (e) => aboutProject(e, project.id, { taskProject: (id) => tasks.get(id)?.project_id }));

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
            <BarAction asChild icon={<PlusIcon />} label="New agent">
              <Link to="/settings/organisation/agents?new=1" />
            </BarAction>
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
                      <Link to={projectSettingsPath(project, "members")}>Add a Member</Link>
                    </Button>
                  )
                }
              >
                {project.name} has no agent Member yet.
              </EmptyState>
            ) : (
              // On a phone the table keeps Agent and Holds, and fits the screen; the rest is in the
              // agent's peek.
              <table className="w-full table-fixed border-collapse md:min-w-[1024px]">
                <thead>
                  <tr className="h-9 border-b text-left text-xs font-medium text-muted-foreground [&>th]:px-2.5 [&>th]:font-medium [&>th:first-child]:pl-4 md:[&>th:first-child]:pl-6">
                    <th className="w-[132px] md:w-[168px]">Agent</th>
                    <th>Holds</th>
                    <th className={cn(wide, "w-[200px]")}>Shift</th>
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
                      runnerSessions={shiftsOf(row.agent.id)}
                      queue={queueOf({ agent: row.agent, held: row.held, open: open.data ?? [], workflow, projectId: project.id, now, history: history.entries, members })}
                      takes={takesOf(workflow, row.agent.id)}
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
  runnerSessions,
  queue,
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
  /** The Shifts the Runner runs for it, the one needing someone first. */
  runnerSessions: RunnerSession[];
  /** The Tasks waiting at a Step it takes while every Shift of its is busy. */
  queue: Task[];
  /** The Steps it takes, in the Project's order, as the page names them (`Bugs › Investigate` of several Workflows). */
  takes: string[];
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
  const runnerSession = runnerSessions[0];
  const taskOf = (s: RunnerSession) => tasks.get(s.task_id) ?? held.find((t) => t.id === s.task_id);
  const actions = agentActions({ agent, held, me, members, shifts: runnerSessions.map((rs) => ({ session: rs, taskKey: taskOf(rs)?.key })), project });
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
          {/* Paused sits beside the name, which gives way first; the other Projects have the line under it to themselves. */}
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-center gap-1.5">
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
              {agent.agent?.paused && <Pill tone="secondary">Paused</Pill>}
            </span>
            {otherProjects.length > 0 && (
              <small className="truncate text-xs text-muted-foreground" title={otherProjects.map((p) => p.name).join(", ")}>
                also {otherProjects.map((p) => p.key).join(" · ")}
              </small>
            )}
          </span>
        </span>
      </td>
      {/* Short of room, what it holds is cut at its column's edge, never over the Shift beside it. */}
      <td className="overflow-hidden">
        {claim ? (
          <span className="flex min-w-0 flex-col gap-0.5">
            {held.map((t) => {
              const c = liveClaim(t, now);
              return (
                <span key={t.id} className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Key to={taskOverAgents(project, t.key)}>{t.key}</Key>
                    <span className="truncate font-medium text-foreground">{t.title}</span>
                  </span>
                  <small className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    {t.step_id && <span className="truncate">{stepName(t.step_id) ?? "a Step"}</span>}
                    {t.blocked && t.open_blockers?.[0] && <Pill tone="blocked">Blocked by {t.open_blockers[0].key}</Pill>}
                    {c?.expires_at && <HeartbeatMeter claim={c} variant="compact" />}
                  </small>
                </span>
              );
            })}
            <QueueLines agent={agent} queue={queue} project={project} stepName={stepName} now={now} />
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
          <span className="flex min-w-0 flex-col gap-1">
            {runnerSessions.map((rs) => {
              const st = taskOf(rs);
              return (
                <span key={rs.session_id} className="flex min-w-0 flex-col items-start gap-0.5">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <SessionStatePill state={rs.state} />
                    {st && (runnerSessions.length > 1 || st.id !== task?.id) && <Key to={taskOverAgents(project, st.key)}>{st.key}</Key>}
                  </span>
                  <small className="flex max-w-full min-w-0 items-center gap-1 text-xs text-muted-foreground">
                    <span className="truncate">{rs.host}</span>
                    <span aria-hidden>·</span>
                    {rs.tmux ? <span className="truncate font-mono">{rs.tmux}</span> : <span>no tmux</span>}
                  </small>
                </span>
              );
            })}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">{agent.agent ? "Not running" : "Not run by the Runner"}</span>
        )}
      </td>
      <td className={wide}>
        <span className="flex min-w-0 flex-col gap-0.5">
          <PillsFit names={detail?.skills.map((s) => s.name) ?? []} />
          <small className="truncate text-xs text-muted-foreground" title={takes.join(", ")}>
            {takes.length > 0 ? takes.join(" · ") : "takes no Step here"}
          </small>
        </span>
      </td>
      <td className={wide}>
        {last ? (
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-xs">{lastWords ? sentenceShort(lastWords) : last.kind}</span>
            <small className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShortTime at={last.at} />
              {lapses.length > 0 && <Pill tone="dropped">{lapses.length === 1 ? "1 lapse" : `${lapses.length} lapses`} in 24h</Pill>}
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
