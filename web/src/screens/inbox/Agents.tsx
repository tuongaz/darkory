import { BotIcon, EllipsisIcon, PlusIcon } from "lucide-react";
import { useCallback, type MouseEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import type { Activity, Feature, Member, MemberDetail, RunnerSession } from "@/api/client";
import { useDirectory, useOpenTasks, useRunnerSessions } from "@/api/queries";
import { Content, TopBar } from "@/app/TopBar";
import { useNow } from "@/clock";
import { EmptyState } from "@/components/EmptyState";
import { HeartbeatMeter } from "@/components/HeartbeatMeter";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Pill } from "@/components/Pill";
import { Refusal } from "@/components/Refusal";
import { RunnerSessionBadge } from "@/components/RunnerSessionBadge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useCurrentMe } from "@/me";
import { liveClaim } from "@/work";
import { AgentMenuItems, AgentPeek, EndPill } from "./AgentPeek";
import { agentActions, agentParam, sessionOverAgents, taskOverAgents } from "./agentActions";
import { agentRows, claimKinds, lapsesIn24h, lastClaimEntry, type AgentRow } from "./derive";
import { useFeatureMap, useMemberDetails, useRecentActivity, useSessions, useTaskMap, type Session } from "./queries";

const claimKindSet = new Set<string>(claimKinds);
// The columns a phone leaves out.
const wide = "hidden md:table-cell";

/** /agents: who is working right now, and is anyone stuck. ?agent=<name> opens one agent's peek. */
export function AgentsPage() {
  const me = useCurrentMe();
  const admin = me.member.admin;
  const now = useNow();
  const { memberList, members, skills } = useDirectory();
  const open = useOpenTasks();
  const features = useFeatureMap();
  const tasks = useTaskMap();
  const [params, setParams] = useSearchParams();
  const selected = params.get(agentParam);

  const rows = agentRows(memberList, open.data ?? [], now);
  const ids = rows.map((r) => r.agent.id);
  const details = useMemberDetails(ids);
  const sessions = useSessions(ids, admin);
  const runner = useRunnerSessions().data?.items ?? [];
  const lapses = useRecentActivity({ kind: ["task.lapsed"] }, (e) => e.kind === "task.lapsed");
  const history = useRecentActivity({ kind: [...claimKinds] }, (e) => claimKindSet.has(e.kind));

  const openPeek = useCallback(
    (name: string) =>
      setParams((p) => {
        const next = new URLSearchParams(p);
        next.set(agentParam, name);
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

  return (
    <>
      <TopBar
        crumbs={[{ label: "Agents" }]}
        primary={
          admin && (
            <Button asChild>
              <Link to="/admin/members?new=1&kind=agent">
                <PlusIcon />
                New agent
              </Link>
            </Button>
          )
        }
      />
      <Content>
        <h1 className="sr-only">Agents</h1>
        {open.isError ? (
          <Refusal error={open.error} className="px-6 py-5" />
        ) : open.isPending || memberList.length === 0 ? (
          <div className="flex flex-col gap-2 px-6 py-5">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<BotIcon />}
            title="No agents"
            action={
              admin && (
                <Button asChild variant="outline">
                  <Link to="/admin/members?new=1&kind=agent">New agent</Link>
                </Button>
              )
            }
          >
            Add an agent Member to see its Claims here.
          </EmptyState>
        ) : (
          // On a phone the table keeps Agent, Holds and Heartbeat, and fits the screen; the rest is in
          // the agent's peek.
          <table className="w-full table-fixed border-collapse md:min-w-[1020px]">
            <thead>
              <tr className="h-9 border-b text-left text-xs font-medium text-muted-foreground [&>th]:px-2.5 [&>th]:font-medium [&>th:first-child]:pl-4 md:[&>th:first-child]:pl-6">
                <th className="w-[132px] md:w-[220px]">Agent</th>
                <th>Holds</th>
                <th className="w-[92px] md:w-[136px]">Heartbeat</th>
                <th className={cn(wide, "w-[196px]")}>Session · model</th>
                <th className={cn(wide, "w-[200px]")}>Skills · Teams</th>
                <th className={cn(wide, "w-[104px] text-right")}>Lapses, 24 h</th>
                <th className={cn(wide, "w-12")}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <AgentTableRow
                  key={row.agent.id}
                  row={row}
                  detail={details[i]?.data}
                  sessions={admin ? sessions[i]?.data : undefined}
                  runnerSession={runner.find((s) => s.member_id === row.agent.id)}
                  admin={admin}
                  lapses={lapsesIn24h(lapses.entries, row.agent.id, now)}
                  last={lastClaimEntry(history.entries, row.agent.id)}
                  selected={selected === row.agent.name}
                  onOpen={openPeek}
                  me={me.member}
                  members={members}
                  features={features}
                  skills={skills}
                  taskKey={(id) => tasks.get(id)?.key}
                />
              ))}
            </tbody>
          </table>
        )}
      </Content>
      {selected && <AgentPeek key={selected} name={selected} onClose={closePeek} />}
    </>
  );
}

function AgentTableRow({
  row,
  detail,
  sessions,
  runnerSession,
  admin,
  lapses,
  last,
  selected,
  onOpen,
  me,
  members,
  features,
  skills,
  taskKey,
}: {
  row: AgentRow;
  detail: MemberDetail | undefined;
  sessions: Session[] | undefined;
  runnerSession: RunnerSession | undefined;
  admin: boolean;
  lapses: Activity[];
  last: Activity | undefined;
  selected: boolean;
  onOpen: (name: string) => void;
  me: Member;
  members: Map<string, Member>;
  features: Map<string, Feature>;
  skills: Map<string, { name: string }>;
  taskKey: (id: string) => string | undefined;
}) {
  const now = useNow();
  const { agent, held } = row;
  const task = held[0];
  const claim = task && liveClaim(task, now);
  const idle = !claim;
  const manager = agent.manager_id ? members.get(agent.manager_id) : undefined;
  const actions = agentActions({ agent, held, me, members, features, sessions });
  // Why an idle agent holds nothing, said once: deactivated, how its last Claim ended, or no Session open.
  const ended = idle && last && last.kind !== "task.claimed" ? last : undefined;
  const endedKey = ended ? taskKey(ended.subject_id) : undefined;
  const noSession = admin && sessions?.length === 0;
  let why: ReactNode = null;
  if (idle && agent.deactivated_at) why = <Pill tone="dropped">Deactivated</Pill>;
  else if (ended && endedKey) {
    why = (
      <>
        <Key to={taskOverAgents(endedKey)}>{endedKey}</Key>
        <EndPill end={ended} when />
      </>
    );
  } else if (idle && noSession) why = <Pill tone="dropped">No Session</Pill>;
  const saidNoSession = idle && noSession && !agent.deactivated_at && !(ended && endedKey);
  const lapsedKeys = [...new Set(lapses.map((l) => taskKey(l.subject_id)).filter((k): k is string => !!k))];
  // The model the agent runs on: the live Claim's label, else its agent settings'.
  const model = claim?.model_label ?? agent.agent?.model;
  const runnerKey = runnerSession && (held.find((t) => t.id === runnerSession.task_id)?.key ?? taskKey(runnerSession.task_id));

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
          <MemberAvatar member={agent} size="md" className={cn(idle && "opacity-60")} />
          <span className="flex min-w-0 flex-col gap-0.5">
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
            {(manager || agent.agent?.paused) && (
              <small className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                {agent.agent?.paused && <Pill tone="secondary">Paused</Pill>}
                {manager && <span className="truncate">reports to {manager.name}</span>}
              </small>
            )}
          </span>
        </span>
      </td>
      <td>
        {claim ? (
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <Key to={taskOverAgents(task.key)}>{task.key}</Key>
              <span className="truncate font-medium text-foreground">{task.title}</span>
              {held.length > 1 && <span className="text-xs whitespace-nowrap text-muted-foreground">+{held.length - 1}</span>}
            </span>
            <small className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {task.blocked && task.open_blockers?.[0] ? (
                <Pill tone="blocked">Blocked by {task.open_blockers[0].key}</Pill>
              ) : (
                claim.skill_id && <span className="truncate">{skills.get(claim.skill_id)?.name}</span>
              )}
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
      <td>{claim && <HeartbeatMeter claim={claim} className="flex-wrap text-foreground" />}</td>
      <td className={wide}>
        {agent.deactivated_at ? null : (
          <span className="flex min-w-0 flex-col items-start gap-0.5">
            {runnerSession && runnerKey ? (
              // The Runner runs it: since when and where, and View opens the Task at its terminal.
              <RunnerSessionBadge session={runnerSession} bare className="max-w-full text-foreground" />
            ) : claim ? (
              <span className="max-w-full truncate font-mono text-xs text-foreground">{claim.session_id}</span>
            ) : admin && sessions && sessions.length > 0 ? (
              <span className="flex max-w-full min-w-0 items-baseline gap-1.5">
                <span className="truncate font-mono text-xs">{sessions[0].id}</span>
                {sessions.length > 1 && <small className="text-xs whitespace-nowrap">+{sessions.length - 1} Sessions</small>}
              </span>
            ) : (
              noSession && !saidNoSession && <Pill tone="dropped">No Session</Pill>
            )}
            {(model || (runnerSession && runnerKey)) && (
              <small className="flex max-w-full min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                {runnerSession && runnerKey && (
                  <Link to={sessionOverAgents(runnerKey)} className="font-medium text-foreground hover:underline">
                    View
                  </Link>
                )}
                {model && <span className="truncate font-mono">{model}</span>}
              </small>
            )}
          </span>
        )}
      </td>
      <td className={wide}>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 gap-1 overflow-hidden">
            {detail?.skills.map((s) => (
              <Pill key={s.id} tone="outline">
                {s.name}
              </Pill>
            ))}
          </span>
          <small className="truncate text-xs text-muted-foreground">{detail?.teams.map((t) => t.name).join(" · ")}</small>
        </span>
      </td>
      <td className={cn(wide, "text-right tabular-nums")}>
        <span className="flex flex-col items-end gap-0.5">
          <span className={cn(lapses.length > 0 && "text-foreground")}>{lapses.length}</span>
          {lapsedKeys.length > 0 && (
            <small className="flex gap-1">
              {lapsedKeys.slice(0, 3).map((k) => (
                <Key key={k} to={taskOverAgents(k)}>
                  {k}
                </Key>
              ))}
            </small>
          )}
        </span>
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
              <AgentMenuItems agent={agent} actions={actions} />
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </td>
    </tr>
  );
}

