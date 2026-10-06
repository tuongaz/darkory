import { ActivityIcon, ArrowRightIcon, HandIcon, HeartPulseIcon, KeyRoundIcon, RotateCcwIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import type { Activity, Task } from "@/api/client";
import { useDirectory, useOpenTasks } from "@/api/queries";
import { useNow } from "@/clock";
import { HeartbeatMeter } from "@/components/HeartbeatMeter";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Peek } from "@/components/Peek";
import { Pill } from "@/components/Pill";
import { PropertiesRail, Property } from "@/components/PropertiesRail";
import { Refusal } from "@/components/Refusal";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useCurrentMe } from "@/me";
import { liveClaim } from "@/work";
import { agentActions, taskOverAgents, type AgentAction } from "./agentActions";
import { agentRows, claimHolder, claimsSince, count, startOfDay, type ClaimRecord } from "./derive";
import { ShortTime } from "./parts";
import { activityLimit, useFeatureMap, useMemberDetails, useRecentActivity, useSessions, useTaskMap, useTokens } from "./queries";
import { timeoutText } from "./wording";

/** The ⋯ menu's items for `actions`. */
export function AgentMenuItems({ actions }: { actions: AgentAction[] }) {
  const navigate = useNavigate();
  return actions.map((a) => (
    <DropdownMenuItem key={a.label} onSelect={() => void navigate(a.to)}>
      {a.label}
    </DropdownMenuItem>
  ));
}

const claimEndWords: Record<string, string> = {
  token_revoked: "Token revoked",
  session_closed: "Session closed",
  member_deactivated: "Deactivated",
};

/** How a Claim ended, as a pill: Completed, Lapsed, Handed over, Released, Taken back, Dropped. */
export function EndPill({ end }: { end: Activity }) {
  switch (end.kind) {
    case "task.completed":
      return <Pill tone="done">Completed</Pill>;
    case "task.lapsed":
      return (
        <Pill tone="dropped">
          <HeartPulseIcon className="size-3" aria-hidden />
          Lapsed
        </Pill>
      );
    case "task.handed_over":
      return (
        <Pill tone="waiting">
          <HandIcon className="size-3" aria-hidden />
          Handed over
        </Pill>
      );
    case "task.taken_back":
      return (
        <Pill tone="claimed">
          <RotateCcwIcon className="size-3" aria-hidden />
          Taken back
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

/** The "Live" mark: a green dot while the agent holds a live Claim. */
export function LiveDot({ children = "Live" }: { children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-2xs font-normal text-muted-foreground">
      <span aria-hidden className="size-1.5 rounded-full bg-state-done" />
      {children}
    </span>
  );
}

/** ?agent=<name> over the Agents page: what this agent has done today, and what holds it now. */
export function AgentPeek({ name, onClose }: { name: string; onClose: () => void }) {
  const me = useCurrentMe();
  const admin = me.member.admin;
  const now = useNow();
  const { memberList, members, skills } = useDirectory();
  const open = useOpenTasks();
  const features = useFeatureMap();
  const tasks = useTaskMap();
  const agent = memberList.find((m) => m.name === name || m.id === name);
  const id = agent?.id ?? "";
  const [detail] = useMemberDetails(agent ? [id] : []);
  const [sessionsQ] = useSessions(agent ? [id] : [], admin);
  const tokens = useTokens(id, !!agent && (admin || me.member.id === id));
  const history = useRecentActivity({ member: id }, (e) => e.actor_id === id || claimHolder(e) === id, !!agent);

  if (!agent) {
    return (
      <Peek open onOpenChange={(o) => !o && onClose()} label={name} heading={<b>{name}</b>}>
        <p className="text-muted-foreground">No Member named {name}.</p>
      </Peek>
    );
  }

  const held = agentRows([agent], open.data ?? [], now)[0]?.held ?? [];
  const claims = withLive(claimsSince(history.entries, id, startOfDay(now)), held, now);
  const sessions = sessionsQ?.data;
  const live = held[0] && liveClaim(held[0], now);
  const manager = agent.manager_id ? members.get(agent.manager_id) : undefined;
  const actions = agentActions({ agent, held, me: me.member, members, features, sessions });
  const entries = history.complete ? count(history.entries.length, "entry", "entries") : `${activityLimit}+ entries`;

  return (
    <Peek
      open
      onOpenChange={(o) => !o && onClose()}
      label={`Agent ${agent.name}`}
      heading={
        <>
          <MemberAvatar member={agent} size="md" />
          <b className="truncate font-semibold">{agent.name}</b>
          {live && <LiveDot />}
          {agent.deactivated_at && <Pill tone="dropped">Deactivated</Pill>}
        </>
      }
      menu={actions.length > 0 ? <AgentMenuItems actions={actions} /> : undefined}
    >
      <PropertiesRail className="grid-cols-[120px_minmax(0,1fr)]">
        <Property label="Session" stack={(sessions?.length ?? 0) > 1}>
          {admin && sessions ? (
            sessions.length === 0 ? (
              <Pill tone="dropped">No Session</Pill>
            ) : (
              sessions.map((s) => (
                <span key={s.id} className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-mono text-xs">{s.id}</span>
                  <span className="whitespace-nowrap text-muted-foreground">
                    · open since <ShortTime at={s.started_at} className="text-sm" />
                  </span>
                </span>
              ))
            )
          ) : live ? (
            <span className="truncate font-mono text-xs">{live.session_id}</span>
          ) : (
            <Pill tone="dropped">No Session</Pill>
          )}
        </Property>
        {live?.model_label && (
          <Property label="Model label">
            <span className="truncate font-mono text-xs">{live.model_label}</span>
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
            {detail?.data?.skills.map((s) => (
              <Pill key={s.id} tone="outline">
                {s.name}
              </Pill>
            ))}
          </span>
        </Property>
        <Property label="Teams">
          <span className="truncate">{detail?.data?.teams.map((t) => t.name).join(" · ")}</span>
        </Property>
      </PropertiesRail>

      <section aria-label="Claims today">
        <h3 className="pb-1.5 text-2xs font-medium tracking-[0.02em] text-muted-foreground">Claims today · {claims.length}</h3>
        <Refusal error={history.query.error} />
        {claims.length > 0 && (
          <ol className="flex flex-col rounded-md border">
            {claims.map((c) => {
              const task = tasks.get(c.taskId) ?? held.find((t) => t.id === c.taskId);
              const holding = held.find((t) => t.claim?.id === c.claimId);
              return (
                <li key={c.claimId} className="grid h-[52px] grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-2.5 border-t px-2.5 first:border-t-0">
                  {task ? <Key to={taskOverAgents(task.key)}>{task.key}</Key> : <span />}
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
                          <span className="text-xs text-muted-foreground">after {timeoutText(c.timeoutSeconds)}</span>
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

      {(admin || me.member.id === id) && (
        <section aria-label="Tokens">
          <h3 className="pb-1.5 text-2xs font-medium tracking-[0.02em] text-muted-foreground">Tokens · {tokens.data?.length ?? 0}</h3>
          <Refusal error={tokens.error} />
          {(tokens.data?.length ?? 0) > 0 && (
            <ul className="flex flex-col rounded-md border">
              {tokens.data!.map((t) => (
                <li
                  key={t.id}
                  className={cn("flex h-[38px] items-center gap-1.5 border-t px-2.5 whitespace-nowrap first:border-t-0", t.revoked_at && "text-muted-foreground")}
                >
                  <KeyRoundIcon className="size-3.5 text-muted-foreground" aria-hidden />
                  <b className="font-medium">{t.name}</b>
                  <span className="font-mono text-xs text-muted-foreground">{t.prefix}…</span>
                  <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                    {t.revoked_at ? (
                      <Pill tone="dropped">Revoked</Pill>
                    ) : (
                      <>
                        issued <ShortTime at={t.created_at} />
                        {t.last_used_at && (
                          <>
                            {" "}
                            · used <ShortTime at={t.last_used_at} />
                          </>
                        )}
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <Link
        to={`/activity?member=${encodeURIComponent(agent.name)}`}
        className="inline-flex items-center gap-1.5 self-start font-medium hover:underline [&_svg]:size-3.5"
      >
        <ActivityIcon aria-hidden />
        Activity · {entries}
        <ArrowRightIcon aria-hidden />
      </Link>
    </Peek>
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
