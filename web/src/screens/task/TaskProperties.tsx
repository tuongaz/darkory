import { useMutation } from "@tanstack/react-query";
import { FolderGit2Icon, GitBranchIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { api, call, type TaskDetail } from "@/api/client";
import { useNow } from "@/clock";
import { HeartbeatMeter } from "@/components/HeartbeatMeter";
import { Key } from "@/components/Key";
import { Pill } from "@/components/Pill";
import { Property, PropertiesRail } from "@/components/PropertiesRail";
import { StatusSelect } from "@/components/StatusSelect";
import { taskBranch } from "@/lib/branch";
import { ClockTime } from "@/components/Time";
import { Skeleton } from "@/components/ui/skeleton";
import { liveClaim } from "@/work";
import type { TaskActions } from "./actions";
import { featurePath } from "./format";
import { MemberName, Needs, StatusLabel, TaskLink } from "./parts";
import { useStatuses, useTakers } from "./queries";
import { lapsedClaim } from "./record";

type Row = { label: string; value: ReactNode; stack?: boolean };

/**
 * A Task's facts. The peek lists them in one run; the page's rail groups them Task · Claim ·
 * Blocking. The Status is a menu for a Member of the Feature's Team and a fact otherwise.
 */
export function TaskProperties({ detail, actions, grouped }: { detail: TaskDetail; actions: TaskActions; grouped?: boolean }) {
  const now = useNow();
  const { task, feature } = detail;
  const claim = liveClaim(task, now);
  const lapsed = claim ? undefined : lapsedClaim(detail);
  const open = task.state === "open";

  const work: Row[] = [
    { label: "Status", value: actions.status === "menu" ? <StatusMenu detail={detail} /> : <StatusFact detail={detail} /> },
    {
      label: "Feature",
      value: (
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          <Link to={featurePath(feature.key)} className="inline-flex min-w-0 items-baseline gap-1.5 hover:underline">
            <Key>{feature.key}</Key>
            <span className="truncate">{feature.title}</span>
          </Link>
          {feature.state === "shipped" && <Pill tone="done">Shipped</Pill>}
          {feature.state === "dropped" && <Pill tone="dropped">Dropped</Pill>}
        </span>
      ),
    },
    { label: "Needs", value: <Needs task={task} /> },
  ];
  // Where a session works it: the Workspaces it names, and the branch the Runner makes in each.
  if (detail.workspaces.length > 0) {
    work.push({ label: "Workspaces", value: <Workspaces detail={detail} /> });
    work.push({ label: "Branch", value: <Branch name={taskBranch(task.key, task.title)} /> });
  }

  const hold: Row[] = [];
  if (claim) {
    hold.push({ label: "Held by", value: <MemberName id={claim.holder_id} /> });
    hold.push({ label: "Heartbeat", value: <HeartbeatMeter claim={claim} /> });
    hold.push({ label: "Session", value: <span className="truncate font-mono text-xs">{claim.session_id}</span> });
    if (claim.model_label) hold.push({ label: "Model", value: <span className="truncate font-mono text-xs">{claim.model_label}</span> });
  } else if (open) {
    hold.push({
      label: "Held by",
      value: (
        <>
          <span className="text-muted-foreground">Nobody</span>
          {lapsed?.ended_at && (
            <Pill tone="dropped">
              Lapsed <ClockTime at={lapsed.ended_at} />
            </Pill>
          )}
        </>
      ),
    });
    hold.push({ label: "Waiting", value: <span>since <ClockTime at={task.waiting_since} /></span> });
    // Who could take it, unless Needs already names the one Member it is aimed at. A Task in a
    // Backlog Status is not takeable, whoever has its Skill.
    if (!task.aimed_at_id) hold.push({
      label: "Takeable by",
      value: detail.status.kind === "backlog" ? <span className="text-muted-foreground">Nobody while in {detail.status.name}</span> : <Takers detail={detail} />,
      stack: true,
    });
  }

  const openBlockers = detail.blockers.filter((b) => b.state === "open");
  const openBlocking = detail.blocking.filter((b) => b.state === "open");
  const blocking: Row[] = [];
  if (openBlockers.length) {
    blocking.push({
      label: "Blocked by",
      stack: true,
      value: openBlockers.map((b) => (
        <TaskLink key={b.id} task={b} className="items-start">
          <Pill tone="blocked">{b.key}</Pill>
          <span className="min-w-0 [overflow-wrap:anywhere]">{b.title}</span>
        </TaskLink>
      )),
    });
  }
  if (openBlocking.length) {
    blocking.push({ label: "Blocks", stack: true, value: openBlocking.map((b) => <TaskLink key={b.id} task={b} wrap />) });
  }

  const groups: [string, Row[]][] = [
    ["Task", work],
    ["Claim", hold],
    ["Blocking", blocking],
  ];
  if (!grouped) return <Rows rows={groups.flatMap(([, rows]) => rows)} />;
  return (
    <div className="flex flex-col gap-5">
      {groups
        .filter(([, rows]) => rows.length)
        .map(([title, rows]) => (
          <section key={title} aria-label={title} className="flex flex-col gap-2">
            <h2 className="text-xs font-medium text-muted-foreground">{title}</h2>
            <Rows rows={rows} compact />
          </section>
        ))}
    </div>
  );
}

function Rows({ rows, compact }: { rows: Row[]; compact?: boolean }) {
  return (
    <PropertiesRail compact={compact}>
      {rows.map((r) => (
        <Fragment key={r.label}>
          <Property label={r.label} stack={r.stack}>
            {r.value}
          </Property>
        </Fragment>
      ))}
    </PropertiesRail>
  );
}

function StatusFact({ detail }: { detail: TaskDetail }) {
  const statuses = useStatuses().data;
  return <StatusLabel status={detail.status} statuses={statuses} />;
}

/** The Status as a select of the open-kind Statuses; Done and Dropped come only by Complete and Drop. */
function StatusMenu({ detail }: { detail: TaskDetail }) {
  const statuses = useStatuses().data;
  const { task, status } = detail;
  const move = useMutation({
    mutationFn: (to: string) => call(api.POST("/v1/tasks/{task}/status", { params: { path: { task: task.id } }, body: { status: to } })),
    onError: (err) => toast.error(`${task.key} not moved`, { description: err.message }),
  });
  return (
    <StatusSelect
      variant="property"
      statuses={statuses ?? [status]}
      value={status.id}
      onValueChange={(to) => to !== status.id && move.mutate(to)}
    />
  );
}

function Workspaces({ detail }: { detail: TaskDetail }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      {detail.workspaces.map((w) => (
        <span key={w.id} className="inline-flex min-w-0 items-center gap-1.5" title={w.path}>
          <FolderGit2Icon className="size-3.5 flex-none text-muted-foreground" aria-hidden />
          <span className="truncate">{w.name}</span>
        </span>
      ))}
    </span>
  );
}

/** A branch name in mono, whole: it wraps in the rail rather than losing its end, so it can be copied. */
export function Branch({ name }: { name: string }) {
  return (
    <span className="inline-flex min-w-0 items-start gap-1.5">
      <GitBranchIcon className="mt-px size-3.5 flex-none text-muted-foreground" aria-hidden />
      <code className="min-w-0 font-mono text-xs [overflow-wrap:anywhere]">{name}</code>
    </span>
  );
}

/** Who could take the Task now, by its Skill or aim: a fact, not a button. */
function Takers({ detail }: { detail: TaskDetail }) {
  const ids = useTakers(detail);
  if (!ids) return <Skeleton className="h-4 w-24" />;
  if (!ids.length) return <span className="text-muted-foreground">Nobody</span>;
  return (
    <>
      {ids.map((id) => (
        <MemberName key={id} id={id} />
      ))}
    </>
  );
}
