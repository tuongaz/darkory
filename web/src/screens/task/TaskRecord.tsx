import { BanIcon, ClockIcon, PaperclipIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { evidenceURL, type Claim, type TaskDetail } from "@/api/client";
import { useNow } from "@/clock";
import { SessionId } from "@/components/CopyValue";
import { Key } from "@/components/Key";
import { Pill } from "@/components/Pill";
import { ClockTime } from "@/components/Time";
import { SystemMark, Timeline, TimelineDay, TimelineRow } from "@/components/Timeline";
import { dayText, sizeText, useMemberName, useSkillName } from "./format";
import { Avatar, SkillPill, TaskLink } from "./parts";
import { durationText, taskRecord, type RecordEntry } from "./record";

/** A Task's record, oldest first, grouped by day when it spans more than today. */
export function TaskRecord({ detail }: { detail: TaskDetail }) {
  const now = useNow();
  const entries = taskRecord(detail);
  const days = new Map<string, RecordEntry[]>();
  for (const e of entries) {
    const d = dayText(e.at, now);
    days.set(d, [...(days.get(d) ?? []), e]);
  }
  const headed = days.size > 1 || !days.has("Today");
  return (
    <Timeline aria-label="Record">
      {[...days].map(([d, rows]) => (
        <Fragment key={d}>
          {headed && <TimelineDay>{d}</TimelineDay>}
          {rows.map((e, i) => (
            <Entry key={i} entry={e} detail={detail} />
          ))}
        </Fragment>
      ))}
    </Timeline>
  );
}

function Entry({ entry, detail }: { entry: RecordEntry; detail: TaskDetail }) {
  const name = useMemberName();
  const skill = useSkillName();
  const when = <ClockTime at={entry.at} />;
  const row = (who: string | undefined, children: ReactNode, sub?: ReactNode) => (
    <TimelineRow who={<Avatar id={who} />} when={when}>
      {children}
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </TimelineRow>
  );
  const { task, feature } = detail;

  switch (entry.kind) {
    case "filed":
      if (task.kind === "retrospective") {
        return row(
          entry.by,
          <>
            Filed when <b>{name(entry.by)}</b> {feature.state === "dropped" ? "dropped" : "shipped"} <Key>{feature.key}</Key>
          </>,
        );
      }
      if (task.kind === "breakdown") {
        return row(
          entry.by,
          <>
            Filed when <b>{name(entry.by)}</b> filed <Key>{feature.key}</Key>
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
      return <ClaimEnded claim={entry.claim} nextSkillId={entry.nextSkillId} when={when} />;
    case "note":
      return (
        <TimelineRow who={<Avatar id={entry.note.author_id} />} when={when}>
          <article className="flex flex-col gap-1.5 rounded-md border bg-card px-3 py-2.5" aria-label={`Note by ${name(entry.note.author_id)}`}>
            <header className="flex items-center gap-2 text-xs text-muted-foreground">
              <b className="text-foreground">{name(entry.note.author_id)}</b> Note
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
          {q.aimed_at_id ? `aimed at ${name(q.aimed_at_id)}` : skill(q.skill_id) && `needs ${skill(q.skill_id)}`} · blocks {task.key}
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
        <TimelineRow who={<SystemMark>{<BanIcon aria-hidden />}</SystemMark>} when={when}>
          Dropped
          {feature.state === "dropped" && feature.ended_at === task.ended_at && (
            <>
              {" "}
              with <Key>{feature.key}</Key>
            </>
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

function ClaimEnded({ claim, nextSkillId, when }: { claim: Claim; nextSkillId?: string; when: ReactNode }) {
  const name = useMemberName();
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
        Claim lapsed{claim.heartbeat_timeout_seconds ? `: no Heartbeat in ${durationText(claim.heartbeat_timeout_seconds)}` : ""}
        <div className="text-xs text-muted-foreground">Recorded by Darkory</div>
      </TimelineRow>
    );
  }
  let what: ReactNode;
  switch (claim.how_ended) {
    case "released":
      what = <>{holder} released it</>;
      break;
    case "handed_over":
      what = (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {holder} handed over to <SkillPill id={nextSkillId} />
        </span>
      );
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
