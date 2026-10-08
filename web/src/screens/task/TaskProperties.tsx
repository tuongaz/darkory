import { FolderGit2Icon, GitBranchIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import type { TaskDetail, WorkflowStep } from "@/api/client";
import { useNow } from "@/clock";
import { CopyValue, SessionId } from "@/components/CopyValue";
import { HeartbeatMeter } from "@/components/HeartbeatMeter";
import { Key } from "@/components/Key";
import { Pill } from "@/components/Pill";
import { Property, PropertiesRail } from "@/components/PropertiesRail";
import { ClockTime } from "@/components/Time";
import { WorkGlyph } from "@/components/WorkGlyph";
import { taskBranch } from "@/lib/branch";
import { liveClaim } from "@/work";
import { progressText } from "../board/derive";
import { useMemberName, useSkillName } from "./format";
import { MemberName, SkillPill, TaskLink } from "./parts";
import { lapsedClaim } from "./record";
import { takersOf } from "./takers";

type Row = { label: string; value: ReactNode; stack?: boolean };

/** Where a Task stands, in words: its Step and Skill, the Member it waits with, its Subtasks, or how it ended. */
export function Standing({ detail, steps }: { detail: TaskDetail; steps: readonly WorkflowStep[] }) {
  const { task } = detail;
  const name = useMemberName();
  if (task.state !== "open") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <WorkGlyph glyph={{ glyph: task.state }} />
        {task.state === "done" ? "Done" : "Dropped"}
      </span>
    );
  }
  if (task.subtask_counts) return <span>Its Subtasks: {progressText(task.subtask_counts)} done</span>;
  if (task.aimed_at_id && !task.step_id) return <span>With {name(task.aimed_at_id)}</span>;
  const step = detail.step ?? steps.find((s) => s.id === task.step_id);
  if (!step) return <span className="text-muted-foreground">No Step</span>;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="font-medium text-foreground">{step.name}</span>
      {step.skill_id ? <SkillPill id={step.skill_id} /> : <Pill tone="secondary">hold</Pill>}
    </span>
  );
}

/** The branch a Task's session works on, in mono, cut short in a narrow rail: the whole name on hover, copied on click. */
export function Branch({ name }: { name: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <GitBranchIcon className="size-3.5 flex-none text-muted-foreground" aria-hidden />
      <CopyValue value={name} what="branch" />
    </span>
  );
}

/**
 * A Task's Claim and Blocking, and where its session works: the peek lists them in one run, the
 * page's rail groups them.
 */
export function TaskProperties({ detail, steps, grouped }: { detail: TaskDetail; steps: readonly WorkflowStep[]; grouped?: boolean }) {
  const now = useNow();
  const skill = useSkillName();
  const { task } = detail;
  const claim = liveClaim(task, now);
  const lapsed = claim ? undefined : lapsedClaim(detail);
  const open = task.state === "open";
  const parent = !!task.subtask_counts;

  const hold: Row[] = [];
  if (claim) {
    hold.push({ label: "Held by", value: <MemberName id={claim.holder_id} /> });
    if (claim.skill_id) hold.push({ label: "Under", value: <span>{skill(claim.skill_id)}{claim.skill_version !== undefined && ` version ${claim.skill_version}`}</span> });
    hold.push({ label: "Heartbeat", value: <HeartbeatMeter claim={claim} /> });
    hold.push({ label: "Session", value: <SessionId id={claim.session_id} /> });
    if (claim.model_label) hold.push({ label: "Model", value: <span className="truncate font-mono text-xs">{claim.model_label}</span> });
  } else if (open && !parent) {
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
    hold.push({
      label: "Waiting",
      value: (
        <span>
          since <ClockTime at={task.step_since ?? task.waiting_since} />
        </span>
      ),
    });
    const step = steps.find((s) => s.id === task.step_id);
    if (!task.aimed_at_id) {
      const takers = takersOf(detail, step);
      hold.push({
        label: "Takeable by",
        stack: true,
        value:
          step && !step.skill_id ? (
            <span className="text-muted-foreground">Nobody while at {step.name}, a hold: move it on</span>
          ) : takers.length ? (
            takers.map((id) => <MemberName key={id} id={id} />)
          ) : (
            <span className="text-muted-foreground">Nobody</span>
          ),
      });
    }
  } else {
    // Nobody holds it, and nobody will: said, so the rail is never empty.
    const why = parent && open ? "a Parent is never claimed" : `it ended ${task.state === "dropped" ? "Dropped" : "Done"}`;
    hold.push({ label: "Held by", value: <span className="text-muted-foreground">Nobody: {why}</span> });
  }

  const work: Row[] = [];
  // Where a session works it: the Workspaces it names, and the branch the Runner makes in each.
  if (detail.workspaces.length > 0) {
    work.push({
      label: "Workspaces",
      value: (
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {detail.workspaces.map((w) => (
            <span key={w.id} className="inline-flex min-w-0 items-center gap-1.5" title={w.path}>
              <FolderGit2Icon className="size-3.5 flex-none text-muted-foreground" aria-hidden />
              <span className="truncate">{w.name}</span>
            </span>
          ))}
        </span>
      ),
    });
    work.push({ label: "Branch", value: <Branch name={taskBranch(task.key, task.title)} /> });
    if (detail.parent) work.push({ label: "Merges into", value: <Branch name={taskBranch(detail.parent.key, detail.parent.title)} /> });
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
  if (openBlocking.length) blocking.push({ label: "Blocks", stack: true, value: openBlocking.map((b) => <TaskLink key={b.id} task={b} wrap />) });

  const groups: [string, Row[]][] = [
    ["Claim", hold],
    ["Blocking", blocking],
    ["Workspace", work],
  ];
  if (!grouped) {
    const rows = groups.flatMap(([, rows]) => rows);
    return rows.length ? <Rows rows={rows} /> : null;
  }
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

/** "WEB-3 Checkout": a Parent, linked to its page. */
export function ParentLink({ parent }: { parent: NonNullable<TaskDetail["parent"]> }) {
  return (
    <TaskLink task={parent}>
      <span className="text-muted-foreground">Parent</span>
      <Key>{parent.key}</Key>
      <span className="truncate">{parent.title}</span>
    </TaskLink>
  );
}
