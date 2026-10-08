import { ArrowRightIcon, BanIcon, CheckIcon, ClockIcon, PaperclipIcon, SplitIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { evidenceURL, type Activity, type Claim, type TaskDetail, type WorkflowStep } from "@/api/client";
import { useNow } from "@/clock";
import { SessionId } from "@/components/CopyValue";
import { Key } from "@/components/Key";
import { Pill } from "@/components/Pill";
import { ClockTime } from "@/components/Time";
import { SystemMark, Timeline, TimelineDay, TimelineRow } from "@/components/Timeline";
import { dayText, sizeText, useMemberName, useSkillName } from "./format";
import { durationText } from "@/lib/time";
import { Avatar, TaskLink } from "./parts";
import { taskRecord, type RecordEntry } from "./record";

/** A Task's record, oldest first, grouped by day when it spans more than today. */
export function TaskRecord({ detail, path, steps }: { detail: TaskDetail; path: readonly Activity[]; steps: readonly WorkflowStep[] }) {
  const now = useNow();
  const entries = taskRecord(detail, path);
  const days = new Map<string, RecordEntry[]>();
  for (const e of entries) {
    const d = dayText(e.at, now);
    days.set(d, [...(days.get(d) ?? []), e]);
  }
  const headed = days.size > 1 || !days.has("Today");
  const stepName = (id: string | undefined) => steps.find((s) => s.id === id)?.name ?? "a Step";
  return (
    <Timeline aria-label="Record">
      {[...days].map(([d, rows]) => (
        <Fragment key={d}>
          {headed && <TimelineDay>{d}</TimelineDay>}
          {rows.map((e, i) => (
            <Entry key={i} entry={e} detail={detail} stepName={stepName} />
          ))}
        </Fragment>
      ))}
    </Timeline>
  );
}

const kinds = { breakdown: "Breakdown", acceptance: "Acceptance", retrospective: "Retrospective" } as const;

function Entry({ entry, detail, stepName }: { entry: RecordEntry; detail: TaskDetail; stepName: (id: string | undefined) => string }) {
  const name = useMemberName();
  const skill = useSkillName();
  const when = <ClockTime at={entry.at} />;
  const row = (who: string | undefined, children: ReactNode, sub?: ReactNode) => (
    <TimelineRow who={who ? <Avatar id={who} /> : <SystemMark />} when={when}>
      {children}
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </TimelineRow>
  );
  const { task, parent } = detail;

  switch (entry.kind) {
    case "filed":
      if (task.kind !== "work" && !entry.by) {
        return row(
          undefined,
          <>
            Darkory filed this {kinds[task.kind]}
            {parent && (
              <>
                {" "}
                under <Key>{parent.key}</Key>
              </>
            )}
          </>,
        );
      }
      return row(
        entry.by,
        <>
          <b>{name(entry.by)}</b> filed the Task
        </>,
      );
    case "claimed": {
      const c = entry.claim;
      const s = skill(c.skill_id);
      return row(
        c.holder_id,
        <>
          <b>{name(c.holder_id)}</b> claimed{s && ` under ${s}`}
          {s && c.skill_version !== undefined && ` version ${c.skill_version}`}
        </>,
        <span className="inline-flex max-w-full min-w-0 items-center gap-1">
          Session <SessionId id={c.session_id} />
          {c.model_label && <span className="truncate font-mono">· {c.model_label}</span>}
        </span>,
      );
    }
    case "claim-ended":
      return <ClaimEnded entry={entry} when={when} stepName={stepName} />;
    case "moved":
      return row(
        entry.by,
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <b>{name(entry.by)}</b> moved it{entry.from && <> from {stepName(entry.from)}</>} to <Pill tone="outline">{stepName(entry.to)}</Pill>
        </span>,
      );
    case "became-parent":
      return (
        <TimelineRow
          who={
            <SystemMark>
              <SplitIcon aria-hidden />
            </SystemMark>
          }
          when={when}
        >
          Became a Parent with its first Subtask
        </TimelineRow>
      );
    case "note":
      return (
        <TimelineRow who={<Avatar id={entry.note.author_id} />} when={when}>
          <article className="flex flex-col gap-1.5 rounded-md border bg-card px-3 py-2.5" aria-label={`Note by ${name(entry.note.author_id)}`}>
            <header className="flex items-center gap-2 text-xs text-muted-foreground">
              <b className="text-foreground">{name(entry.note.author_id)}</b> Note
              {skill(entry.note.skill_id) && <span>under {skill(entry.note.skill_id)}</span>}
            </header>
            <p className="whitespace-pre-wrap">{entry.note.body}</p>
          </article>
        </TimelineRow>
      );
    case "observation": {
      const o = entry.observation;
      return (
        <TimelineRow who={<Avatar id={o.author_id} />} when={when}>
          <article className="flex flex-col gap-1.5 rounded-md border px-3 py-2.5" aria-label={`Observation by ${name(o.author_id)}`}>
            <header className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <OutcomePill outcome={o.outcome} />
              <b className="text-foreground">{name(o.author_id)}</b>
              {skill(o.skill_id) && <span>under {skill(o.skill_id)}</span>}
            </header>
            <p className="whitespace-pre-wrap">{o.body}</p>
          </article>
        </TimelineRow>
      );
    }
    case "evidence": {
      const e = entry.evidence;
      return row(
        e.attached_by,
        <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
          <b>{name(e.attached_by)}</b> attached
          <a href={evidenceURL(e.id)} download={e.filename} className="inline-flex min-w-0 items-center gap-1 hover:underline">
            <PaperclipIcon className="size-3 flex-none text-muted-foreground" aria-hidden />
            <span className="truncate">{e.filename}</span>
          </a>
          <span className="text-muted-foreground">{sizeText(e.size)}</span>
        </span>,
      );
    }
    case "question": {
      const q = entry.question;
      return row(
        q.filed_by,
        <span className="flex min-w-0 items-baseline gap-1.5">
          <b className="whitespace-nowrap">{name(q.filed_by)}</b> filed <TaskLink task={q} />
        </span>,
        <>
          {q.aimed_at_id ? `aimed at ${name(q.aimed_at_id)}` : q.step_id ? `at ${stepName(q.step_id)}` : ""} · blocks {task.key}
          {q.state !== "open" && ` · ${q.state === "done" ? "Done" : "Dropped"}`}
        </>,
      );
    }
    case "proposal":
      return row(
        entry.proposal.author_id,
        <>
          <b>{name(entry.proposal.author_id)}</b> proposed {skill(entry.proposal.skill_id)} version {entry.proposal.based_on_version + 1}
        </>,
      );
    case "ended":
      return (
        <TimelineRow
          who={
            entry.by ? (
              <Avatar id={entry.by} />
            ) : (
              <SystemMark>{entry.state === "done" ? <CheckIcon aria-hidden /> : <BanIcon aria-hidden />}</SystemMark>
            )
          }
          when={when}
        >
          {entry.by ? (
            <>
              <b>{name(entry.by)}</b> {entry.state === "done" ? "completed it" : "dropped it"}
            </>
          ) : entry.auto ? (
            `Completed itself (Auto-complete)${entry.after ? ` when ${entry.after} ended` : ""}`
          ) : entry.state === "done" ? (
            "Completed"
          ) : (
            "Dropped"
          )}
        </TimelineRow>
      );
  }
}

const endings: Record<string, string> = {
  token_revoked: "token revoked",
  session_closed: "Session closed",
  member_deactivated: "deactivated",
};

function ClaimEnded({ entry, when, stepName }: { entry: Extract<RecordEntry, { kind: "claim-ended" }>; when: ReactNode; stepName: (id: string | undefined) => string }) {
  const name = useMemberName();
  const claim: Claim = entry.claim;
  const holder = <b>{name(claim.holder_id)}</b>;
  if (claim.how_ended === "lapsed") {
    return (
      <TimelineRow
        who={
          <SystemMark>
            <ClockIcon aria-hidden />
          </SystemMark>
        }
        when={when}
      >
        Claim lapsed{claim.heartbeat_timeout_seconds ? `: no Heartbeat in ${durationText(claim.heartbeat_timeout_seconds * 1000)}` : ""}
        <div className="text-xs text-muted-foreground">Recorded by Darkory</div>
      </TimelineRow>
    );
  }
  let what: ReactNode;
  switch (claim.how_ended) {
    case "released":
      what = <>{holder} released it</>;
      break;
    case "advanced":
      what = entry.advanced ? (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {holder} advanced it <Pill tone="secondary">{entry.advanced.outcome}</Pill>
          <ArrowRightIcon className="size-3 text-muted-foreground" aria-hidden />
          <Pill tone="outline">{stepName(entry.advanced.to)}</Pill>
        </span>
      ) : (
        <>{holder} advanced it</>
      );
      break;
    case "split":
      what = <>{holder} split it into Subtasks; their Claim ended</>;
      break;
    case "completed":
      what = <>{holder} completed it</>;
      break;
    case "taken_back":
      what = <>{holder}&apos;s Claim was taken back</>;
      break;
    default:
      what = (
        <>
          {holder}&apos;s Claim ended: {endings[claim.how_ended ?? ""] ?? "ended"}
        </>
      );
  }
  return (
    <TimelineRow who={<Avatar id={claim.holder_id} />} when={when}>
      {what}
    </TimelineRow>
  );
}

export function OutcomePill({ outcome }: { outcome: "worked" | "didnt_work" }) {
  return outcome === "worked" ? <Pill tone="done">Worked</Pill> : <Pill tone="blocked">Didn&apos;t work</Pill>;
}
