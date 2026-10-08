import type { ReactNode } from "react";
import { Link } from "react-router";
import type { Member, MemberDetail, RunnerSession, Task } from "@/api/client";
import { useMe, useMember, useMembers, useOpenTasks, useRunnerSessions } from "@/api/queries";
import { usePeekLink } from "@/app/peek";
import { useNow } from "@/clock";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Pill } from "@/components/Pill";
import { Refusal } from "@/components/Refusal";
import { Skeleton } from "@/components/ui/skeleton";
import { memberSettingsPath } from "@/lib/members";
import { lastedText } from "@/lib/time";
import { workingOf, workingWords } from "@/lib/work";
import { liveClaim } from "@/work";

/** A Task the Member holds now, with the Runner's session on it when one runs. */
type Held = { task: Task; since: string; session?: RunnerSession };

/** How many reports the card names before "and N more". */
const namedReports = 3;
/** How many held Tasks the card lists before "and N more". */
const listedHeld = 2;

/**
 * What a Member's hover card says (`MemberAvatar`'s): the mark, name, kind and Admin; what they
 * are doing now (the Tasks they hold, an agent's session state and for how long); their Skills;
 * an agent's model; the Reporting line both ways; their Projects; and, for an admin, a link to
 * their page in Settings. Reads `GET /v1/members/{id}` (one query per Member, shared by every card
 * for them) and what the app already holds: the Members, the open Tasks, the Runner's sessions.
 */
export function MemberCard({ id }: { id: string }) {
  const detail = useMember(id);
  if (detail.isPending) return <CardSkeleton />;
  if (detail.isError) return <Refusal error={detail.error} />;
  return <CardBody detail={detail.data} />;
}

function CardSkeleton() {
  return (
    <div data-loading className="flex flex-col gap-3" aria-busy="true" aria-label="Loading the Member">
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-full" />
        <div className="flex flex-1 flex-col gap-1.5">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3 w-16" />
        </div>
      </div>
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-3 w-40" />
      <Skeleton className="h-3 w-32" />
    </div>
  );
}

function CardBody({ detail }: { detail: MemberDetail }) {
  const { member, skills, projects, reports } = detail;
  const me = useMe().data?.member;
  const members = useMembers().data;
  const manager = member.manager_id ? members?.find((m) => m.id === member.manager_id) : undefined;
  const isAgent = member.kind === "agent";
  const held = useHeld(member);
  const first = held?.[0];

  return (
    <div data-member-card={member.name} className="flex flex-col gap-3 text-xs">
      <div className="flex items-center gap-3">
        <MemberAvatar member={member} size="lg" card={false} working={first && workingOf(member.kind, first.session?.state)} />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-sm font-semibold">
            {member.name}
            {me?.id === member.id && <span className="ml-1 font-normal text-muted-foreground">(you)</span>}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted-foreground">{isAgent ? "Agent" : "Human"}</span>
            {member.admin && <Pill>Admin</Pill>}
            {member.agent?.paused && <Pill tone="claimed">Paused</Pill>}
            {member.deactivated_at && <Pill tone="dropped">Deactivated</Pill>}
          </span>
        </div>
      </div>

      <Now member={member} held={held} />

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2">
        <Fact label="Skills">
          {skills.length === 0 ? (
            <span className="text-muted-foreground">None</span>
          ) : (
            <span className="flex flex-wrap gap-1">
              {skills.map((s) => (
                <Pill key={s.id} tone="outline">
                  {s.name}
                </Pill>
              ))}
            </span>
          )}
        </Fact>
        {isAgent && member.agent?.model && (
          <Fact label="Model">
            <span className="font-mono text-[11.5px] [overflow-wrap:anywhere]">{member.agent.model}</span>
          </Fact>
        )}
        {(manager || isAgent) && (
          <Fact label="Reports to">
            {manager ? <Named member={manager} /> : <span className="text-muted-foreground">No one</span>}
          </Fact>
        )}
        {reports.length > 0 && (
          <Fact label="Reports">
            <span>
              <span className="tabular-nums">{reports.length}</span>
              <span className="text-muted-foreground"> · </span>
              {reports
                .slice(0, namedReports)
                .map((r) => r.name)
                .join(", ")}
              {reports.length > namedReports && <span className="text-muted-foreground"> and {reports.length - namedReports} more</span>}
            </span>
          </Fact>
        )}
        {projects.length > 0 && (
          <Fact label="Projects">
            <span className="[overflow-wrap:anywhere]">{projects.map((p) => p.name).join(", ")}</span>
          </Fact>
        )}
      </dl>

      {me?.admin && (
        <div className="-mx-4 -mb-4 border-t px-4 py-2.5">
          <Link to={memberSettingsPath(member)} className="font-medium text-foreground hover:underline">
            Open profile
          </Link>
        </div>
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function Named({ member }: { member: Member }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 align-middle">
      <MemberAvatar member={member} card={false} />
      <span className="truncate">{member.name}</span>
    </span>
  );
}

/**
 * The Tasks the Member holds a live Claim on, the longest held first, each with the Runner's
 * session on it and since when it has been as it is (the session's state, else the Claim);
 * undefined while the open Tasks load.
 */
function useHeld(member: Member): Held[] | undefined {
  const tasks = useOpenTasks();
  const sessions = useRunnerSessions().data?.items;
  const now = useNow();
  if (tasks.isPending) return undefined;
  const held: (Held & { claimed: string })[] = [];
  for (const task of tasks.data ?? []) {
    const claim = liveClaim(task, now);
    if (claim?.holder_id !== member.id) continue;
    const session = sessions?.find((s) => s.task_id === task.id && s.member_id === member.id);
    held.push({ task, session, since: session?.state_since ?? claim.started_at, claimed: claim.started_at });
  }
  return held.sort((a, b) => a.claimed.localeCompare(b.claimed));
}

/** What the Member is doing now: the Tasks they hold, or nothing. */
function Now({ member, held }: { member: Member; held: Held[] | undefined }) {
  const now = useNow();
  const peek = usePeekLink();

  if (!held) return <Skeleton className="h-8 w-full" />;
  if (held.length === 0) {
    return (
      <p data-now="idle" className="rounded-md bg-muted px-2.5 py-2 text-muted-foreground">
        Not working on anything
      </p>
    );
  }
  return (
    <ul data-now="working" className="flex flex-col gap-2 rounded-md bg-muted px-2.5 py-2">
      {held.slice(0, listedHeld).map(({ task, session, since }) => {
        const words = workingWords[workingOf(member.kind, session?.state)];
        return (
          <li key={task.id} className="flex min-w-0 flex-col gap-0.5">
            <Link to={peek(task.key)} className="flex min-w-0 items-baseline gap-1.5 hover:underline">
              <Key>{task.key}</Key>
              <span className="truncate">{task.title}</span>
            </Link>
            <span className="text-muted-foreground">
              {words[0].toUpperCase() + words.slice(1)} for {lastedText(now - new Date(since).getTime())}
            </span>
          </li>
        );
      })}
      {held.length > listedHeld && <li className="text-muted-foreground">and {held.length - listedHeld} more</li>}
    </ul>
  );
}
