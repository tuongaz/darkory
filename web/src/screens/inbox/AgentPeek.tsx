import {
  ActivityIcon,
  ArrowRightIcon,
  BellRingIcon,
  HeartPulseIcon,
  LogInIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  RouteIcon,
  SettingsIcon,
  SplitIcon,
  SquareIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import type { Activity, Member, Project, RunnerSession, Task } from "@/api/client";
import { useDirectory, useMember, useOpenTasks, useRunnerSessions, useWorkflow } from "@/api/queries";
import { projectPath } from "@/app/currentProject";
import { useNow } from "@/clock";
import { SessionId } from "@/components/CopyValue";
import { HeartbeatMeter } from "@/components/HeartbeatMeter";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Peek } from "@/components/Peek";
import { Pill } from "@/components/Pill";
import { ProjectMark } from "@/components/ProjectMark";
import { PropertiesRail, Property } from "@/components/PropertiesRail";
import { Refusal } from "@/components/Refusal";
import { SessionFacts } from "@/components/RunnerSessionBadge";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { untilText } from "@/lib/time";
import { workingOf } from "@/lib/work";
import { useCurrentMe } from "@/me";
import { heldClaims } from "@/screens/settings/model";
import { SessionsTable } from "@/screens/settings/SessionsTable";
import { liveClaim } from "@/work";
import { agentActions, agentSettingsPath, sessionOverAgents, taskOverAgents, type AgentAction } from "./agentActions";
import { useAgentActions } from "./useAgentActions";
import { agentRows, claimHolder, claimsSince, count, startOfDay, takesOf, type ClaimRecord } from "./derive";
import { activityLimit, useRecentActivity, useSessions, useStepNames, useTaskMap } from "./queries";

const actionIcons: Record<string, ReactNode> = {
  Nudge: <BellRingIcon />,
  "Stop Shift": <SquareIcon />,
  Pause: <PauseIcon />,
  Resume: <PlayIcon />,
  "Open in Settings": <SettingsIcon />,
};

/** The ⋯ menu's items for an agent's `actions`. */
export function AgentMenuItems({ actions, run }: { actions: AgentAction[]; run: (a: AgentAction) => void }) {
  return actions.map((a) => (
    <DropdownMenuItem key={a.label} onSelect={() => run(a)} variant={"session" in a && a.session === "stop" ? "destructive" : undefined}>
      {actionIcons[a.label] ?? <RotateCcwIcon />}
      {a.label}
    </DropdownMenuItem>
  ));
}

const claimEndWords: Record<string, string> = {
  token_revoked: "Token revoked",
  session_closed: "Session closed",
  member_deactivated: "Deactivated",
};

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/**
 * How a Claim ended, as a pill: Completed, Advanced (with its outcome), Released, Split, Lapsed,
 * Taken back, Dropped. `when` adds the time of a lapse ("Lapsed 22:18"), where the row gives no
 * other time.
 */
export function EndPill({ end, when }: { end: Activity; when?: boolean }) {
  const outcome = typeof end.payload.outcome === "string" ? end.payload.outcome : undefined;
  switch (end.kind) {
    case "task.completed":
      return <Pill tone="done">Completed</Pill>;
    case "task.advanced":
      return (
        <Pill tone="waiting">
          <RouteIcon className="size-3" aria-hidden />
          Advanced{outcome && ` · ${outcome}`}
        </Pill>
      );
    case "task.lapsed":
      return (
        <Pill tone="dropped">
          <HeartPulseIcon className="size-3" aria-hidden />
          Lapsed{when && <time dateTime={end.at}> {clock.format(new Date(end.at))}</time>}
        </Pill>
      );
    case "task.taken_back":
      return (
        <Pill tone="claimed">
          <RotateCcwIcon className="size-3" aria-hidden />
          Taken back
        </Pill>
      );
    case "task.split":
      return (
        <Pill tone="secondary">
          <SplitIcon className="size-3" aria-hidden />
          Split
        </Pill>
      );
    case "task.released":
      return <Pill tone="secondary">Released</Pill>;
    case "task.dropped":
      return <Pill tone="dropped">Dropped</Pill>;
    default: {
      const how = typeof end.payload.how_ended === "string" ? end.payload.how_ended : "";
      return <Pill tone="dropped">{claimEndWords[how] ?? "Ended"}</Pill>;
    }
  }
}

/**
 * ?agent=<name> over a Project's Agents page: what holds the agent now, the Shift the Runner
 * runs for it, its Sessions, its Projects and Skills and the Steps it can take here, and its
 * Claims today. Nudge, Stop, Pause and its page in Settings are in the ⋯ menu for an admin.
 */
export function AgentPeek({ name, project, onClose }: { name: string; project: Project; onClose: () => void }) {
  const me = useCurrentMe();
  const admin = me.member.admin;
  const now = useNow();
  const { memberList, members, skills, projects } = useDirectory();
  const open = useOpenTasks();
  const tasks = useTaskMap();
  const steps = useStepNames();
  const workflow = useWorkflow(project.key).data;
  const agent = memberList.find((m) => m.name === name || m.id === name);
  const id = agent?.id ?? "";
  const detail = useMember(agent ? id : undefined);
  const sessionsQ = useSessions(id, admin && !!agent);
  const history = useRecentActivity({ member: id }, (e) => e.actor_id === id || claimHolder(e) === id, !!agent);
  const runnerSession = useRunnerSessions().data?.items.find((s) => s.member_id === id);
  const { run, dialog } = useAgentActions(agent);

  if (!agent) {
    return (
      <Peek open onOpenChange={(o) => !o && onClose()} label={name} heading={<b>{name}</b>}>
        <p className="text-muted-foreground">No Member named {name}.</p>
      </Peek>
    );
  }

  const held = agentRows([agent], open.data ?? [], now)[0]?.held ?? [];
  const claims = withLive(claimsSince(history.entries, id, startOfDay(now)), held, now);
  const live = held[0] && liveClaim(held[0], now);
  const set = agent.agent?.model;
  const model = live?.model_label ?? set;
  const manager = agent.manager_id ? members.get(agent.manager_id) : undefined;
  const sessionTask = runnerSession && (tasks.get(runnerSession.task_id) ?? held.find((t) => t.id === runnerSession.task_id));
  const actions = agentActions({ agent, held, me: me.member, members, session: runnerSession, sessionKey: sessionTask?.key, project });
  const entries = history.complete ? count(history.entries.length, "entry", "entries") : `${activityLimit}+ entries`;
  const takes = takesOf(workflow, id);
  const working = live ? workingOf("agent", runnerSession?.state) : runnerSession?.state === "ending" ? "ending" : undefined;

  return (
    <Peek
      open
      onOpenChange={(o) => !o && onClose()}
      label={`Agent ${agent.name}`}
      heading={
        <>
          <MemberAvatar member={agent} size="md" working={working} />
          <b className="truncate font-semibold">{agent.name}</b>
          {agent.agent?.paused && <Pill tone="secondary">Paused</Pill>}
          {agent.deactivated_at && <Pill tone="dropped">Deactivated</Pill>}
        </>
      }
      menu={actions.length > 0 ? <AgentMenuItems actions={actions} run={run} /> : undefined}
    >
      <PropertiesRail className="grid-cols-[120px_minmax(0,1fr)]">
        <Property label="Holds" stack={held.length > 1}>
          {held.length === 0 ? (
            <span className="text-muted-foreground">Nothing</span>
          ) : (
            held.map((t) => {
              const claim = liveClaim(t, now);
              return (
                <span key={t.id} className="flex min-w-0 items-center gap-1.5">
                  <Key to={taskOverAgents(project, t.key)}>{t.key}</Key>
                  <span className="truncate">{t.title}</span>
                  {t.step_id && <span className="whitespace-nowrap text-muted-foreground">· {steps.get(t.step_id)?.name ?? "a Step"}</span>}
                  {claim?.expires_at && <HeartbeatMeter claim={claim} variant="compact" className="ml-auto text-xs" />}
                </span>
              );
            })
          )}
        </Property>
        {!admin && (
          // Only an admin may list another Member's Sessions; anyone sees the one holding the Claim.
          <Property label="Session">
            {live ? (
              <SessionId id={live.session_id} className="min-w-0" />
            ) : (
              <span className="text-muted-foreground">None holding a Claim</span>
            )}
          </Property>
        )}
        {model && (
          // The model the live Claim names, else the agent settings'; settings that name another follow it.
          <Property label="Model">
            <span className="truncate font-mono text-xs">{model}</span>
            {set && set !== model && <span className="truncate text-xs text-muted-foreground">· set to {set}</span>}
          </Property>
        )}
        {manager && (
          <Property label="Reports to">
            <MemberAvatar member={manager} />
            <span className="truncate">{manager.name}</span>
          </Property>
        )}
        <Property label="Skills">
          <span className="flex flex-wrap gap-1">
            {detail.data?.skills.map((s) => (
              <Pill key={s.id} tone="outline">
                {s.name}
              </Pill>
            ))}
          </span>
        </Property>
        <Property label={`Steps in ${project.name}`}>
          {takes.length === 0 ? <span className="text-muted-foreground">None</span> : <span className="truncate">{takes.join(" · ")}</span>}
        </Property>
        <Property label="Projects">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            {(detail.data?.projects ?? []).map((p) => (
              <Link key={p.id} to={projectPath(projects.get(p.id) ?? p, "agents")} className="inline-flex items-center gap-1.5 hover:underline">
                <ProjectMark project={p} />
                {p.name}
              </Link>
            ))}
          </span>
        </Property>
      </PropertiesRail>

      {runnerSession && <RunnerSessionSection agent={agent} session={runnerSession} task={sessionTask} admin={admin} project={project} run={run} />}

      {admin && (
        <section aria-label="Sessions">
          <h3 className="pb-1.5 text-2xs font-medium tracking-[0.02em] text-muted-foreground">Sessions · {sessionsQ.data?.open ?? "…"}</h3>
          <Refusal error={sessionsQ.error} />
          {sessionsQ.data && (
            <SessionsTable
              member={agent}
              sessions={sessionsQ.data}
              held={heldClaims(held)}
              runner={runnerSession}
              taskTo={(key) => taskOverAgents(project, key)}
              self={agent.id === me.member.id}
              canClose
              compact
            />
          )}
        </section>
      )}

      <section aria-label="Claims today">
        <h3 className="pb-1.5 text-2xs font-medium tracking-[0.02em] text-muted-foreground">Claims today · {claims.length}</h3>
        <Refusal error={history.query.error} />
        {claims.length > 0 && (
          <ol className="flex flex-col rounded-md border">
            {claims.map((c) => {
              const task = tasks.get(c.taskId) ?? held.find((t) => t.id === c.taskId);
              const holding = held.find((t) => t.claim?.id === c.claimId);
              return (
                <li key={c.claimId} className="grid h-[52px] grid-cols-[60px_minmax(0,1fr)_auto] items-center gap-2.5 border-t px-2.5 first:border-t-0">
                  {task ? <Key to={taskOverAgents(project, task.key)}>{task.key}</Key> : <span />}
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate font-medium">{task?.title ?? "a Task"}</span>
                    <small className="truncate text-xs text-muted-foreground">
                      claimed <ClaimedAt at={c.claimedAt} />
                      {c.skillId && ` · ${skills.get(c.skillId)?.name ?? "a Skill"}`}
                    </small>
                  </span>
                  <span className="flex items-center justify-end gap-1.5 whitespace-nowrap">
                    {c.end ? (
                      <>
                        {c.end.kind === "task.lapsed" && c.timeoutSeconds && (
                          <span className="text-xs text-muted-foreground">after {untilText(c.timeoutSeconds * 1000)}</span>
                        )}
                        <EndPill end={c.end} />
                      </>
                    ) : (
                      holding?.claim && <HeartbeatMeter claim={holding.claim} className="text-xs" />
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link
          to={`${projectPath(project, "activity")}?member=${encodeURIComponent(agent.name)}`}
          className="inline-flex items-center gap-1.5 font-medium hover:underline [&_svg]:size-3.5"
        >
          <ActivityIcon aria-hidden />
          Activity · {entries}
          <ArrowRightIcon aria-hidden />
        </Link>
        {admin && (
          <Link to={agentSettingsPath(agent)} className="inline-flex items-center gap-1.5 font-medium hover:underline [&_svg]:size-3.5">
            <SettingsIcon aria-hidden />
            Settings
            <ArrowRightIcon aria-hidden />
          </Link>
        )}
      </div>
      {dialog}
    </Peek>
  );
}

/**
 * The Shift the Runner runs for the agent now: its facts, View (the Task's peek at its Session
 * panel) and, for an admin, Join, Nudge and Stop.
 */
function RunnerSessionSection({
  agent,
  session,
  task,
  admin,
  project,
  run,
}: {
  agent: Member;
  session: RunnerSession;
  task: Task | undefined;
  admin: boolean;
  project: Project;
  run: (a: AgentAction) => void;
}) {
  const navigate = useNavigate();
  return (
    <section aria-label="Shift">
      <h3 className="pb-1.5 text-2xs font-medium tracking-[0.02em] text-muted-foreground">Shift</h3>
      <div className="flex flex-col rounded-md border">
        <SessionFacts session={session} agent={agent} className="min-h-9 border-b px-2.5 py-1.5" />
        {task && (
          <div className="flex min-h-9 min-w-0 flex-wrap items-center gap-1.5 px-2.5 py-1">
            <Key to={taskOverAgents(project, task.key)}>{task.key}</Key>
            <span className="min-w-0 flex-1 truncate">{task.title}</span>
            <span className="ml-auto flex flex-none items-center gap-1.5">
              <Button asChild variant="ghost" size="xs">
                <Link to={sessionOverAgents(project, task.key)}>View</Link>
              </Button>
              {admin && session.state !== "ending" && (
                <>
                  <Button variant="ghost" size="xs" onClick={() => run({ label: "Nudge", session: "nudge", taskKey: task.key })}>
                    <BellRingIcon />
                    Nudge
                  </Button>
                  <Button variant="ghost" size="xs" onClick={() => run({ label: "Stop Shift", session: "stop", taskKey: task.key })}>
                    <SquareIcon />
                    Stop
                  </Button>
                </>
              )}
              {admin && session.tmux && (
                <Button variant="outline" size="xs" onClick={() => void navigate(sessionOverAgents(project, task.key), { state: { join: true } })}>
                  <LogInIcon />
                  Join
                </Button>
              )}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

const withSeconds = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

function ClaimedAt({ at }: { at: string }) {
  return (
    <time dateTime={at} className="tabular-nums">
      {withSeconds.format(new Date(at))}
    </time>
  );
}

/** Today's Claims, plus a live one started before today, so what holds the agent now is always listed. */
function withLive(claims: ClaimRecord[], held: Task[], now: number): ClaimRecord[] {
  const out = [...claims];
  for (const t of held) {
    const c = liveClaim(t, now);
    if (c && !out.some((r) => r.claimId === c.id)) {
      out.unshift({ claimId: c.id, taskId: t.id, claimedAt: c.started_at, skillId: c.skill_id, modelLabel: c.model_label, timeoutSeconds: c.heartbeat_timeout_seconds });
    }
  }
  return out;
}
