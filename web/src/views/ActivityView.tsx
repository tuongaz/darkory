import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { Link } from "react-router";
import { api, call, type Activity, type ActivityKind } from "../api/client";
import { useLiveEntries } from "../api/live";
import { keys, useDirectory } from "../api/queries";
import { Refusal, Time } from "../components/ui";
import { MemberName, SkillName } from "../components/work";

const pageSize = 100;
// A `before` past every entry reads the latest page.
const newest = Number.MAX_SAFE_INTEGER;

/**
 * Activity, newest first: the latest page and the pages before it, read backwards with `before`,
 * and whatever the stream delivered since. Entries are numbered without gaps, so a stream entry
 * more than one past the newest one read means some were missed between the two; the history is
 * then read again.
 */
export function ActivityView() {
  const live = useLiveEntries();
  const history = useInfiniteQuery({
    queryKey: keys.activity,
    queryFn: ({ pageParam }) => call(api.GET("/v1/activity", { params: { query: { before: pageParam, limit: pageSize } } })),
    initialPageParam: newest,
    getNextPageParam: (page) =>
      page.items.length < pageSize || page.first_seq === undefined || page.first_seq <= 1 ? undefined : page.first_seq,
  });

  const bySeq = new Map<number, Activity>();
  for (const page of history.data?.pages ?? []) for (const e of page.items) bySeq.set(e.seq, e);
  for (const e of live) bySeq.set(e.seq, e);
  const entries = [...bySeq.values()].sort((a, b) => b.seq - a.seq);
  // Entries about a Task or Feature carry its key and title only when it was filed, so later
  // entries borrow them from the filing entry when it has been read.
  const names = new Map<string, string>();
  for (const e of entries) {
    const named = nameIn(e.payload);
    if (named) names.set(e.subject_id, named);
  }

  const newestRead = history.data?.pages[0]?.items.at(-1)?.seq ?? 0;
  const oldestLive = live.at(-1)?.seq;
  const missed = history.isSuccess && oldestLive !== undefined && oldestLive > newestRead + 1;
  const { refetch, isFetching } = history;
  useEffect(() => {
    if (missed && !isFetching) void refetch();
  }, [missed, isFetching, refetch]);

  return (
    <>
      <h1>Activity</h1>
      <p className="muted">Every change to the record, newest first, as it happens.</p>
      <Refusal error={history.error} />
      {history.isPending && <p className="muted">Loading…</p>}
      {history.isSuccess && entries.length === 0 && <p className="muted">Nothing has happened yet.</p>}
      <ol className="list activity" aria-label="Activity" aria-live="polite" aria-relevant="additions">
        {entries.map((e) => (isKnown(e.kind) ? <ActivityItem key={e.seq} entry={e} name={names.get(e.subject_id)} /> : null))}
      </ol>
      {history.hasNextPage && (
        <p className="more">
          <button type="button" onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage}>
            Load older entries
          </button>
        </p>
      )}
    </>
  );
}

// What each kind of entry says its actor did, ahead of the record it is about.
const said: Record<ActivityKind, string> = {
  "feature.filed": "filed",
  "feature.ranked": "ranked",
  "feature.shipped": "shipped",
  "feature.dropped": "dropped",
  "feature.owner_passed": "passed the ownership of",
  "feature.evidence_attached": "attached Evidence to",
  "task.filed": "filed",
  "task.claimed": "claimed",
  "task.lapsed": "recorded a lapsed Claim on",
  "task.released": "released",
  "task.handed_over": "handed over",
  "task.completed": "completed",
  "task.dropped": "dropped",
  "task.taken_back": "took back",
  "task.claim_ended": "ended a Claim on",
  "task.note_added": "added a Note to",
  "task.observed": "recorded an Observation on",
  "task.blocker_added": "added a blocker to",
  "task.blocker_removed": "removed a blocker from",
  "task.evidence_attached": "attached Evidence to",
  "task.skill_proposed": "proposed a Skill version on",
  "task.status_set": "moved",
  "statuses.changed": "changed the Statuses of",
  "skill.created": "created the Skill",
  "skill.version_published": "published a version of",
  "member.created": "created the Member",
  "member.updated": "updated the Member",
  "member.manager_set": "set the Reporting line of",
  "member.manager_cleared": "removed the Reporting line of",
  "member.skill_granted": "granted a Skill to",
  "member.skill_revoked": "took a Skill away from",
  "member.deactivated": "deactivated the Member",
  "member.reactivated": "reactivated the Member",
  "team.created": "created the Team",
  "team.member_added": "added a Member to",
  "team.member_removed": "removed a Member from",
  "token.issued": "issued a token",
  "token.revoked": "revoked a token",
  "session.closed": "closed a Session",
  "login_link.issued": "issued a login link",
  "login_link.redeemed": "signed in with a login link",
};

// The spec adds kinds within /v1 and asks clients to skip those they do not know.
function isKnown(kind: string): kind is ActivityKind {
  return Object.hasOwn(said, kind);
}

function ActivityItem({ entry, name }: { entry: Activity; name: string | undefined }) {
  return (
    <li>
      <span className="seq">#{entry.seq}</span>
      <div className="grow">
        <MemberName id={entry.actor_id} /> <span title={entry.kind}>{said[entry.kind]}</span>{" "}
        <Subject entry={entry} name={name} />
        <Detail entry={entry} />
        <div className="meta">
          <Time at={entry.at} />
        </div>
      </div>
    </li>
  );
}

function text(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
}

/** A Task's or Feature's display key and title, from a payload that carries them. */
function nameIn(payload: Record<string, unknown>): string | undefined {
  return [text(payload, "key"), text(payload, "title")].filter(Boolean).join(" ") || undefined;
}

/** The record an entry is about, named and linked where the app has a page for it. */
function Subject({ entry, name }: { entry: Activity; name: string | undefined }) {
  const { teams, skills } = useDirectory();
  const p = entry.payload;
  switch (entry.subject_type) {
    case "task":
      return <Link to={`/tasks/${entry.subject_id}`}>{name ?? "a Task"}</Link>;
    case "feature":
      return <Link to={`/features/${entry.subject_id}`}>{name ?? "a Feature"}</Link>;
    case "member":
      return <MemberName id={entry.subject_id} />;
    case "team": {
      const t = teams.get(entry.subject_id);
      return <span>{t ? `${t.name} (${t.key})` : (text(p, "name") ?? "a Team")}</span>;
    }
    case "skill":
      return <span className="skill">{skills.get(entry.subject_id)?.name ?? text(p, "name") ?? "a Skill"}</span>;
    case "token":
      return (
        <span>
          {text(p, "name") && <code>{text(p, "name")}</code>} for <MemberName id={text(p, "member_id")} />
        </span>
      );
    case "login_link":
      return entry.kind === "login_link.issued" ? (
        <span>
          for <MemberName id={text(p, "member_id")} />
        </span>
      ) : null;
    default:
      return null;
  }
}

/** The facts of an entry worth a glance, from its payload. */
function Detail({ entry }: { entry: Activity }) {
  const p = entry.payload;
  const parts: ReactNode[] = [];
  switch (entry.kind) {
    case "feature.ranked":
      parts.push(`from position ${text(p, "from")} to ${text(p, "to")}`);
      break;
    case "feature.owner_passed":
      parts.push(
        <>
          to <MemberName id={text(p, "to")} />
        </>,
      );
      break;
    case "feature.dropped":
      if (text(p, "open_tasks_dropped")) parts.push(`${text(p, "open_tasks_dropped")} open Tasks dropped`);
      break;
    case "task.handed_over":
      parts.push(
        <>
          to <SkillName id={text(p, "skill_id")} />
        </>,
      );
      break;
    case "task.lapsed":
    case "task.claim_ended":
      parts.push(
        <>
          held by <MemberName id={text(p, "holder_id")} />
          {text(p, "how_ended") && `, ${text(p, "how_ended")?.replaceAll("_", " ")}`}
        </>,
      );
      break;
    case "task.blocker_added":
    case "task.blocker_removed":
      if (text(p, "blocker_key")) {
        parts.push(
          <>
            blocker <Link to={`/tasks/${text(p, "blocker_key")}`}>{text(p, "blocker_key")}</Link>
          </>,
        );
      }
      break;
    case "task.observed":
      parts.push(text(p, "outcome") === "worked" ? "worked" : "didn't work");
      break;
    case "task.evidence_attached":
    case "feature.evidence_attached":
      if (text(p, "filename")) parts.push(text(p, "filename"));
      break;
    case "task.skill_proposed":
      parts.push(
        <>
          for <SkillName id={text(p, "skill_id")} />, based on version {text(p, "based_on_version")}
        </>,
      );
      break;
    case "skill.version_published":
      parts.push(`version ${text(p, "version")}`);
      break;
    case "member.skill_granted":
    case "member.skill_revoked":
      parts.push(<SkillName id={text(p, "skill_id")} />);
      break;
    case "member.manager_set":
      parts.push(
        <>
          to <MemberName id={text(p, "manager_id")} />
        </>,
      );
      break;
    case "team.member_added":
    case "team.member_removed":
      parts.push(<MemberName id={text(p, "member_id")} />);
      break;
    case "session.closed":
      if (text(p, "claims_ended")) parts.push(`${text(p, "claims_ended")} Claims ended`);
      break;
  }
  if (parts.length === 0) return null;
  return (
    <>
      {" "}
      <span className="muted">
        ·{" "}
        {parts.map((part, i) => (
          <span key={i}>{part}</span>
        ))}
      </span>
    </>
  );
}
